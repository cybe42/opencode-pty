import type { OpencodeClient } from '@opencode-ai/sdk'
import {
  MAX_TIMER_DELAY_SECONDS,
  NOTIFICATION_LINE_TRUNCATE,
  NOTIFICATION_TITLE_TRUNCATE,
} from '../constants.ts'
import type { NudgeAction, NudgeSource, PTYSession } from './types.ts'

export const AUTOMATIC_NUDGE_INTERVAL_SECONDS = [30, 60, 120, 240, 480, 900, 1800] as const

const NUDGE_DELIVERY_DELAY_MS = 25
const NUDGE_DELIVERY_RETRY_MS = 5000

type TimerHandle = ReturnType<typeof setTimeout>
export type ParentSessionStatus = 'idle' | 'busy' | 'retry'
type ParentTerminalOutcome = 'unknown' | 'clean' | 'nonclean'

export interface NudgeClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

const systemClock: NudgeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

interface QueuedNudge {
  session: PTYSession
  generation: number
  source: NudgeSource
}

interface NudgeSnapshot extends QueuedNudge {
  endPosition: number
  message: string
}

interface ModelContext {
  model?: { providerID: string; modelID: string }
  variant?: string
}

function sanitizeStructuredField(value: string, limit?: number): string {
  const tokens: string[] = []
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (character === '&') tokens.push('&amp;')
    else if (character === '<') tokens.push('&lt;')
    else if (character === '>') tokens.push('&gt;')
    else if (character === '\r') tokens.push('\\r')
    else if (character === '\n') tokens.push('\\n')
    else if (character === '\t') tokens.push('\\t')
    else if (character === '\u2028') tokens.push('\\u2028')
    else if (character === '\u2029') tokens.push('\\u2029')
    else if (codePoint >= 32 && (codePoint < 127 || codePoint > 159)) tokens.push(character)
  }

  if (limit === undefined) {
    return tokens.join('')
  }

  const totalLength = tokens.reduce((length, token) => length + [...token].length, 0)
  if (totalLength <= limit) {
    return tokens.join('')
  }

  const budget = Math.max(0, limit - 3)
  let result = ''
  let resultLength = 0
  for (const token of tokens) {
    const tokenLength = [...token].length
    if (resultLength + tokenLength > budget) {
      break
    }
    result += token
    resultLength += tokenLength
  }
  return `${result}...`
}

export class NudgeManager {
  private client: OpencodeClient | null = null
  private nudgeTimers = new Map<string, { handle: TimerHandle; session: PTYSession }>()
  private activeSessions = new Map<string, PTYSession>()
  private pendingNudges = new Map<string, Map<string, QueuedNudge>>()
  private parentStatuses = new Map<string, ParentSessionStatus>()
  private parentStatusVersions = new Map<string, number>()
  private parentTerminalOutcomes = new Map<string, ParentTerminalOutcome>()
  private pausedNudgeDelays = new Map<string, number>()
  private deliveryTimers = new Map<string, TimerHandle>()
  private flushingParents = new Set<string>()
  private submittingSessions = new Map<string, number>()
  private manualActivityDuringSubmission = new Map<string, number>()

  constructor(private readonly clock: NudgeClock = systemClock) {}

  init(client: OpencodeClient): void {
    this.client = client
  }

  startNudge(session: PTYSession): void {
    if (!session.nudgeEnabled || session.status !== 'running') {
      return
    }
    this.activeSessions.set(session.id, session)
    this.deferNudge(session)
  }

  recordManualActivity(session: PTYSession): void {
    session.nudgeLastOutputPosition = session.buffer.position
    if (!session.nudgeEnabled || session.status !== 'running') {
      return
    }
    if (this.submittingSessions.get(session.id) === session.nudgeGeneration) {
      this.manualActivityDuringSubmission.set(session.id, this.clock.now())
      return
    }

    if (
      session.nudgePolicy === 'automatic' &&
      !session.nudgePaused &&
      session.nudgeOneShotDelaySeconds === undefined
    ) {
      this.invalidateSchedule(session)
      this.armNudge(session)
      return
    }

    session.nudgeGeneration++
    if (
      session.nudgeNextDueAt !== undefined &&
      session.nudgeNextDueAt <= this.clock.now() &&
      !this.nudgeTimers.has(session.id)
    ) {
      const source =
        session.nudgeOneShotDelaySeconds !== undefined ? 'one-shot' : session.nudgePolicy
      this.queueNudge(session, source)
    }
  }

  configureNudge(session: PTYSession, action: NudgeAction, seconds?: number): void {
    if (!session.nudgeEnabled) {
      throw new Error(`Nudges are not available for PTY session '${session.id}'.`)
    }
    if (session.status !== 'running') {
      throw new Error(`Cannot configure nudges for PTY '${session.id}' - session is not running.`)
    }

    let validatedSeconds: number | undefined
    if (action === 'next' || action === 'every') {
      validatedSeconds = this.requireSeconds(seconds, action)
    } else {
      this.rejectSeconds(seconds, action)
    }

    this.invalidateSchedule(session)
    switch (action) {
      case 'next':
        session.nudgeOneShotDelaySeconds = validatedSeconds
        break
      case 'every':
        session.nudgePolicy = 'recurring'
        session.nudgeIntervalSeconds = validatedSeconds
        session.nudgePaused = false
        session.nudgeOneShotDelaySeconds = undefined
        break
      case 'pause':
        session.nudgePaused = true
        session.nudgeOneShotDelaySeconds = undefined
        break
      case 'resume':
        session.nudgePaused = false
        session.nudgeOneShotDelaySeconds = undefined
        break
      case 'automatic':
        session.nudgePolicy = 'automatic'
        session.nudgeAutomaticStep = 0
        session.nudgeIntervalSeconds = undefined
        session.nudgePaused = false
        session.nudgeOneShotDelaySeconds = undefined
        break
    }

    this.activeSessions.set(session.id, session)
    this.armNudge(session)
  }

  clearNudge(session: PTYSession): void {
    this.invalidateSchedule(session)
    this.manualActivityDuringSubmission.delete(session.id)
    this.pausedNudgeDelays.delete(session.id)
    this.activeSessions.delete(session.id)
  }

  clearByParentSession(parentSessionId: string): void {
    this.clearDeliveryTimer(parentSessionId)
    for (const session of [...this.activeSessions.values()]) {
      if (session.parentSessionId === parentSessionId) {
        this.clearNudge(session)
      }
    }
    this.pendingNudges.delete(parentSessionId)
    this.parentStatuses.delete(parentSessionId)
    this.parentStatusVersions.delete(parentSessionId)
    this.parentTerminalOutcomes.delete(parentSessionId)
  }

  handleParentSessionStatus(parentSessionId: string, status: ParentSessionStatus): void {
    const previousStatus = this.parentStatuses.get(parentSessionId)
    this.parentStatusVersions.set(
      parentSessionId,
      (this.parentStatusVersions.get(parentSessionId) ?? 0) + 1
    )
    this.parentStatuses.set(parentSessionId, status)
    if (status === 'busy' || status === 'retry') {
      if (previousStatus !== 'busy' && previousStatus !== 'retry') {
        this.parentTerminalOutcomes.set(parentSessionId, 'unknown')
      }
      this.pauseParentNudges(parentSessionId)
      return
    }

    if (this.parentTerminalOutcomes.get(parentSessionId) !== 'clean') {
      this.pauseParentNudges(parentSessionId)
      return
    }

    this.resumeParentNudges(parentSessionId)
  }

  handleParentAssistantMessage(
    parentSessionId: string,
    completed: boolean,
    errorName: string | undefined
  ): void {
    if (errorName !== undefined) {
      this.parentTerminalOutcomes.set(parentSessionId, 'nonclean')
      this.pauseParentNudges(parentSessionId, false)
      return
    }
    this.parentTerminalOutcomes.set(parentSessionId, completed ? 'clean' : 'unknown')
  }

  handleParentSessionError(parentSessionId: string): void {
    this.parentTerminalOutcomes.set(parentSessionId, 'nonclean')
    this.pauseParentNudges(parentSessionId, false)
  }

  private requireSeconds(seconds: number | undefined, action: NudgeAction): number {
    if (
      seconds === undefined ||
      !Number.isInteger(seconds) ||
      seconds <= 0 ||
      seconds > MAX_TIMER_DELAY_SECONDS
    ) {
      throw new Error(
        `seconds must be a positive integer no greater than ${MAX_TIMER_DELAY_SECONDS} for nudge action '${action}'`
      )
    }
    return seconds
  }

  private rejectSeconds(seconds: number | undefined, action: NudgeAction): void {
    if (seconds !== undefined) {
      throw new Error(`seconds is not used by nudge action '${action}'`)
    }
  }

  private getAutomaticInterval(session: PTYSession, stepOffset: number = 0): number {
    const step = Math.min(
      session.nudgeAutomaticStep + stepOffset,
      AUTOMATIC_NUDGE_INTERVAL_SECONDS.length - 1
    )
    return AUTOMATIC_NUDGE_INTERVAL_SECONDS[step] ?? 1800
  }

  private getNextSchedule(
    session: PTYSession
  ): { delaySeconds: number; source: NudgeSource } | null {
    if (session.nudgeOneShotDelaySeconds !== undefined) {
      return { delaySeconds: session.nudgeOneShotDelaySeconds, source: 'one-shot' }
    }
    if (session.nudgePaused) {
      return null
    }
    if (session.nudgePolicy === 'recurring') {
      if (session.nudgeIntervalSeconds === undefined) {
        return null
      }
      return { delaySeconds: session.nudgeIntervalSeconds, source: 'recurring' }
    }
    return { delaySeconds: this.getAutomaticInterval(session), source: 'automatic' }
  }

  private invalidateSchedule(session: PTYSession): void {
    session.nudgeGeneration++
    session.nudgeNextDueAt = undefined
    this.clearNudgeTimer(session.id)
    this.pausedNudgeDelays.delete(session.id)
    this.removePendingNudge(session)
  }

  private clearNudgeTimer(id: string): void {
    const timer = this.nudgeTimers.get(id)
    if (!timer) {
      return
    }
    this.clock.clearTimeout(timer.handle)
    this.nudgeTimers.delete(id)
  }

  private scheduleNextNudge(session: PTYSession, dueAtOverride?: number): void {
    this.clearNudgeTimer(session.id)
    session.nudgeNextDueAt = undefined
    if (session.status !== 'running') {
      return
    }

    const schedule = this.getNextSchedule(session)
    if (!schedule) {
      return
    }

    session.nudgeNextDueAt = dueAtOverride ?? this.clock.now() + schedule.delaySeconds * 1000
    const delayMs = Math.max(0, session.nudgeNextDueAt - this.clock.now())
    const handle = this.clock.setTimeout(() => {
      const currentTimer = this.nudgeTimers.get(session.id)
      if (currentTimer?.handle !== handle) {
        return
      }
      this.nudgeTimers.delete(session.id)
      if (session.status !== 'running') {
        return
      }
      this.queueNudge(session, schedule.source)
    }, delayMs)

    this.nudgeTimers.set(session.id, { handle, session })
  }

  private isParentCleanIdle(parentSessionId: string): boolean {
    return (
      this.parentTerminalOutcomes.get(parentSessionId) === 'clean' &&
      this.parentStatuses.get(parentSessionId) === 'idle'
    )
  }

  private deferNudge(session: PTYSession): void {
    const schedule = this.getNextSchedule(session)
    this.clearNudgeTimer(session.id)
    session.nudgeNextDueAt = undefined
    if (!schedule) {
      this.pausedNudgeDelays.delete(session.id)
      return
    }
    if (this.isParentCleanIdle(session.parentSessionId)) {
      this.armNudge(session)
      return
    }
    this.pausedNudgeDelays.set(session.id, schedule.delaySeconds * 1000)
  }

  private armNudge(session: PTYSession): void {
    if (!this.isParentCleanIdle(session.parentSessionId)) {
      this.deferNudge(session)
      return
    }
    const remainingDelay = this.pausedNudgeDelays.get(session.id)
    this.pausedNudgeDelays.delete(session.id)
    this.scheduleNextNudge(
      session,
      remainingDelay === undefined ? undefined : this.clock.now() + remainingDelay
    )
  }

  private pauseParentNudges(parentSessionId: string, preserveRemainingDelay: boolean = true): void {
    this.clearDeliveryTimer(parentSessionId)
    this.pendingNudges.delete(parentSessionId)
    for (const session of this.activeSessions.values()) {
      if (session.parentSessionId !== parentSessionId) {
        continue
      }
      if (preserveRemainingDelay && session.nudgeNextDueAt !== undefined) {
        this.pausedNudgeDelays.set(
          session.id,
          Math.max(0, session.nudgeNextDueAt - this.clock.now())
        )
      } else if (!preserveRemainingDelay) {
        this.pausedNudgeDelays.delete(session.id)
      }
      session.nudgeNextDueAt = undefined
      this.clearNudgeTimer(session.id)
    }
  }

  private resumeParentNudges(parentSessionId: string): void {
    for (const session of this.activeSessions.values()) {
      if (session.parentSessionId === parentSessionId && session.status === 'running') {
        this.armNudge(session)
      }
    }
  }

  private queueNudge(session: PTYSession, source: NudgeSource): void {
    let pending = this.pendingNudges.get(session.parentSessionId)
    if (!pending) {
      pending = new Map()
      this.pendingNudges.set(session.parentSessionId, pending)
    }
    pending.set(session.id, { session, generation: session.nudgeGeneration, source })

    if (this.isParentCleanIdle(session.parentSessionId)) {
      this.scheduleDelivery(session.parentSessionId)
    }
  }

  private removePendingNudge(session: PTYSession): void {
    const pending = this.pendingNudges.get(session.parentSessionId)
    pending?.delete(session.id)
    if (pending?.size === 0) {
      this.pendingNudges.delete(session.parentSessionId)
      this.clearDeliveryTimer(session.parentSessionId)
    }
  }

  private clearDeliveryTimer(parentSessionId: string): void {
    const handle = this.deliveryTimers.get(parentSessionId)
    if (!handle) {
      return
    }
    this.clock.clearTimeout(handle)
    this.deliveryTimers.delete(parentSessionId)
  }

  private scheduleDelivery(
    parentSessionId: string,
    delayMs: number = NUDGE_DELIVERY_DELAY_MS
  ): void {
    if (this.deliveryTimers.has(parentSessionId) || this.flushingParents.has(parentSessionId)) {
      return
    }

    const handle = this.clock.setTimeout(() => {
      if (this.deliveryTimers.get(parentSessionId) !== handle) {
        return
      }
      this.deliveryTimers.delete(parentSessionId)
      void this.flushParentNudges(parentSessionId)
    }, delayMs)
    this.deliveryTimers.set(parentSessionId, handle)
  }

  private async getParentIdleState(parentSessionId: string): Promise<'idle' | 'busy' | 'unknown'> {
    if (this.parentTerminalOutcomes.get(parentSessionId) !== 'clean') {
      return 'busy'
    }
    const knownStatus = this.parentStatuses.get(parentSessionId)
    if (knownStatus === 'busy' || knownStatus === 'retry') {
      return 'busy'
    }
    if (!this.client) {
      return 'unknown'
    }

    const statusVersion = this.parentStatusVersions.get(parentSessionId) ?? 0
    try {
      const response = await this.client.session.status({ throwOnError: true })
      const statuses = response.data as Record<string, { type: ParentSessionStatus }> | undefined
      const remoteStatus = statuses?.[parentSessionId]?.type
      if ((this.parentStatusVersions.get(parentSessionId) ?? 0) !== statusVersion) {
        const latestStatus = this.parentStatuses.get(parentSessionId)
        if (latestStatus !== 'idle') {
          return latestStatus ? 'busy' : 'unknown'
        }
        return remoteStatus === 'busy' || remoteStatus === 'retry' ? 'unknown' : 'idle'
      }
      const latestStatus = this.parentStatuses.get(parentSessionId)
      if (latestStatus === 'busy' || latestStatus === 'retry') {
        return 'busy'
      }

      if (remoteStatus === 'busy' || remoteStatus === 'retry') {
        this.parentStatuses.set(parentSessionId, remoteStatus)
        return 'busy'
      }

      this.parentStatuses.set(parentSessionId, 'idle')
      return 'idle'
    } catch {
      if ((this.parentStatusVersions.get(parentSessionId) ?? 0) !== statusVersion) {
        const latestStatus = this.parentStatuses.get(parentSessionId)
        return latestStatus === 'idle' ? 'idle' : latestStatus ? 'busy' : 'unknown'
      }
      if (this.isParentCleanIdle(parentSessionId)) {
        return 'unknown'
      }
      this.parentStatuses.delete(parentSessionId)
      return 'unknown'
    }
  }

  private async flushParentNudges(parentSessionId: string): Promise<void> {
    if (this.flushingParents.has(parentSessionId)) {
      return
    }
    this.flushingParents.add(parentSessionId)

    let detached: QueuedNudge[] = []
    let retryAfterFlush = false
    try {
      const idleState = await this.getParentIdleState(parentSessionId)
      if (idleState !== 'idle') {
        retryAfterFlush = idleState === 'unknown'
        return
      }

      const pending = this.pendingNudges.get(parentSessionId)
      if (!pending) {
        return
      }

      detached = [...pending.values()].filter(
        ({ session, generation }) =>
          session.status === 'running' && session.nudgeGeneration === generation
      )
      for (const entry of detached) {
        if (pending.get(entry.session.id) === entry) {
          pending.delete(entry.session.id)
        }
      }
      if (pending.size === 0) {
        this.pendingNudges.delete(parentSessionId)
      }
      if (detached.length === 0) {
        return
      }

      const snapshots = detached.map((entry) => this.buildNudgeSnapshot(entry))
      if (!this.isParentCleanIdle(parentSessionId)) {
        this.requeueNudges(detached)
        detached = []
        return
      }

      const deliveredSnapshots = await this.sendNudgeBatch(parentSessionId, snapshots)
      for (const snapshot of deliveredSnapshots) {
        this.completeDeliveredNudge(snapshot)
      }
      detached = []
    } catch {
      this.rescheduleFailedAutomaticSubmissions(detached)
      this.requeueNudges(detached)
      retryAfterFlush = true
    } finally {
      this.flushingParents.delete(parentSessionId)
      const pending = this.pendingNudges.get(parentSessionId)
      if (pending?.size && this.isParentCleanIdle(parentSessionId)) {
        this.scheduleDelivery(
          parentSessionId,
          retryAfterFlush ? NUDGE_DELIVERY_RETRY_MS : NUDGE_DELIVERY_DELAY_MS
        )
      }
    }
  }

  private requeueNudges(entries: QueuedNudge[]): void {
    for (const entry of entries) {
      const { session, generation } = entry
      if (session.status !== 'running' || session.nudgeGeneration !== generation) {
        continue
      }
      let pending = this.pendingNudges.get(session.parentSessionId)
      if (!pending) {
        pending = new Map()
        this.pendingNudges.set(session.parentSessionId, pending)
      }
      if (!pending.has(session.id)) {
        pending.set(session.id, entry)
      }
    }
  }

  private rescheduleFailedAutomaticSubmissions(entries: QueuedNudge[]): void {
    for (const entry of entries) {
      const manualActivityAt = this.manualActivityDuringSubmission.get(entry.session.id)
      if (manualActivityAt === undefined) {
        continue
      }
      this.manualActivityDuringSubmission.delete(entry.session.id)
      if (
        entry.source !== 'automatic' ||
        entry.session.status !== 'running' ||
        entry.session.nudgeGeneration !== entry.generation
      ) {
        continue
      }

      entry.session.nudgeGeneration++
      const dueAt = manualActivityAt + this.getAutomaticInterval(entry.session) * 1000
      this.pausedNudgeDelays.set(entry.session.id, Math.max(0, dueAt - this.clock.now()))
      this.armNudge(entry.session)
    }
  }

  private describeTrigger(entry: QueuedNudge): string {
    if (entry.source === 'one-shot') {
      return `one-shot override after ${entry.session.nudgeOneShotDelaySeconds ?? 'unknown'}s`
    }
    if (entry.source === 'recurring') {
      return `recurring every ${entry.session.nudgeIntervalSeconds ?? 'unknown'}s`
    }
    return `automatic step ${entry.session.nudgeAutomaticStep + 1}`
  }

  private describeAfterNudge(entry: QueuedNudge): string {
    const { session } = entry
    if (session.nudgePaused) {
      return 'paused until resumed'
    }
    if (session.nudgePolicy === 'recurring') {
      return `recurring in ${session.nudgeIntervalSeconds ?? 'unknown'}s`
    }
    return `automatic in ${this.getAutomaticInterval(session, 1)}s`
  }

  private buildNudgeSnapshot(entry: QueuedNudge): NudgeSnapshot {
    const { session } = entry
    const delta = session.buffer.readRawFrom(session.nudgeLastOutputPosition)
    const elapsedSeconds = Math.max(
      0,
      Math.floor((this.clock.now() - session.createdAt.getTime()) / 1000)
    )
    const lastOutputActivity =
      session.lastOutputAt === undefined
        ? 'none yet'
        : `${Math.max(0, Math.floor((this.clock.now() - session.lastOutputAt) / 1000))}s ago`
    const displayTitle = session.description ?? session.title
    const title = sanitizeStructuredField(displayTitle, NOTIFICATION_TITLE_TRUNCATE)

    const newOutputLines = delta.data === '' ? [] : delta.data.split('\n')
    if (newOutputLines.at(-1) === '') {
      newOutputLines.pop()
    }
    let lastNewLine = ''
    for (let i = newOutputLines.length - 1; i >= 0; i--) {
      const line = newOutputLines[i]
      if (line !== undefined && line.trim() !== '') {
        const sanitizedLine = sanitizeStructuredField(line, NOTIFICATION_LINE_TRUNCATE)
        if (sanitizedLine.trim() !== '') {
          lastNewLine = sanitizedLine
          break
        }
      }
    }

    return {
      ...entry,
      endPosition: delta.endPosition,
      message: [
        '<pty_nudge>',
        `ID: ${session.id}`,
        `Description: ${title}`,
        'Status: process running',
        `Elapsed: ${elapsedSeconds}s | Last Output Activity: ${lastOutputActivity}`,
        `Nudge Trigger: ${this.describeTrigger(entry)}`,
        `After This Nudge: ${this.describeAfterNudge(entry)}`,
        `New Output Lines: ${delta.truncated ? `at least ${newOutputLines.length}` : newOutputLines.length}`,
        `Last New Line: ${delta.truncated ? 'unavailable (new output exceeded rolling buffer)' : lastNewLine}`,
        '</pty_nudge>',
      ].join('\n'),
    }
  }

  private completeDeliveredNudge(snapshot: NudgeSnapshot): void {
    const { session, generation, source } = snapshot
    this.manualActivityDuringSubmission.delete(session.id)
    if (session.status !== 'running' || session.nudgeGeneration !== generation) {
      return
    }

    session.nudgeLastOutputPosition = Math.max(
      session.nudgeLastOutputPosition,
      snapshot.endPosition
    )
    if (source === 'one-shot') {
      session.nudgeOneShotDelaySeconds = undefined
    }
    if (session.nudgePolicy === 'automatic' && source !== 'recurring') {
      session.nudgeAutomaticStep = Math.min(
        session.nudgeAutomaticStep + 1,
        AUTOMATIC_NUDGE_INTERVAL_SECONDS.length - 1
      )
    }
    // The prompt starts a new parent turn. A later clean completion is required before rearming.
    this.parentTerminalOutcomes.set(session.parentSessionId, 'unknown')
    this.deferNudge(session)
  }

  private async getModelContext(parentSessionId: string): Promise<ModelContext> {
    if (!this.client) {
      return {}
    }

    try {
      const parent = await this.client.session.get({ path: { id: parentSessionId } })
      const model = (
        parent.data as
          | (typeof parent.data & {
              model?: { id: string; providerID: string; variant?: string }
            })
          | undefined
      )?.model
      if (!model) {
        return {}
      }
      return {
        model: { providerID: model.providerID, modelID: model.id },
        ...(model.variant ? { variant: model.variant } : {}),
      }
    } catch {
      return {}
    }
  }

  private async sendNudgeBatch(
    parentSessionId: string,
    snapshots: NudgeSnapshot[]
  ): Promise<NudgeSnapshot[]> {
    if (!this.client) {
      throw new Error('Nudge manager is not initialized')
    }

    let currentSnapshots = snapshots.filter(
      ({ session, generation }) =>
        session.status === 'running' && session.nudgeGeneration === generation
    )
    if (currentSnapshots.length === 0) {
      return []
    }

    const modelContext = await this.getModelContext(parentSessionId)
    currentSnapshots = currentSnapshots.filter(
      ({ session, generation }) =>
        session.status === 'running' && session.nudgeGeneration === generation
    )
    if (currentSnapshots.length === 0) {
      return []
    }
    if ((await this.getParentIdleState(parentSessionId)) !== 'idle') {
      throw new Error('Parent session became busy before nudge delivery')
    }
    currentSnapshots = currentSnapshots.filter(
      ({ session, generation }) =>
        session.status === 'running' && session.nudgeGeneration === generation
    )
    if (currentSnapshots.length === 0) {
      return []
    }

    const firstAgent = currentSnapshots[0]?.session.parentAgent
    const targetAgent = currentSnapshots.every(({ session }) => session.parentAgent === firstAgent)
      ? firstAgent
      : undefined
    const message = currentSnapshots.map((snapshot) => snapshot.message).join('\n\n')

    // The SDK has no atomic "prompt only if idle" operation. The event plus status
    // snapshot is best effort; a new user turn can still race this promptAsync call.
    // A batch can target only one prompt-level agent. Mixed-agent batches retain
    // each originating agent in their blocks and use the parent session default.
    for (const snapshot of currentSnapshots) {
      this.submittingSessions.set(snapshot.session.id, snapshot.generation)
    }
    try {
      await this.client.session.promptAsync({
        path: { id: parentSessionId },
        throwOnError: true,
        body: {
          parts: [{ type: 'text', text: message }],
          ...(targetAgent ? { agent: targetAgent } : {}),
          ...modelContext,
        },
      })
    } finally {
      for (const snapshot of currentSnapshots) {
        if (this.submittingSessions.get(snapshot.session.id) === snapshot.generation) {
          this.submittingSessions.delete(snapshot.session.id)
        }
      }
    }
    return currentSnapshots
  }
}
