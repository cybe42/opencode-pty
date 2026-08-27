import type { OpencodeClient } from '@opencode-ai/sdk'
import { Terminal } from 'bun-pty'
import { NotificationManager } from './notification-manager.ts'
import { NudgeManager, type ParentSessionStatus } from './nudge-manager.ts'
import { OutputManager } from './output-manager.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type {
  NudgeAction,
  PTYSessionInfo,
  ReadResult,
  SearchResult,
  SpawnOptions,
} from './types.ts'
import { withSession } from './utils.ts'

const proto = Terminal.prototype as unknown as { _startReadLoop?: (...args: unknown[]) => unknown }

const original = proto._startReadLoop

if (typeof original === 'function') {
  proto._startReadLoop = async function (this: InstanceType<typeof Terminal>, ...args: unknown[]) {
    await Promise.resolve() // Yield to allow event handlers to be registered
    return original.apply(this, args)
  }
}

type SessionUpdateCallback = (session: PTYSessionInfo) => void

export const sessionUpdateCallbacks: SessionUpdateCallback[] = []

export function registerSessionUpdateCallback(callback: SessionUpdateCallback) {
  sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback) {
  const index = sessionUpdateCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionUpdateCallbacks.splice(index, 1)
  }
}

function notifySessionUpdate(session: PTYSessionInfo) {
  for (const callback of sessionUpdateCallbacks) {
    try {
      callback(session)
    } catch {
      // Ignore callback errors
    }
  }
}

type RawOutputCallback = (session: PTYSessionInfo, rawData: string) => void

export const rawOutputCallbacks: RawOutputCallback[] = []

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const index = rawOutputCallbacks.indexOf(callback)
  if (index !== -1) {
    rawOutputCallbacks.splice(index, 1)
  }
}

function notifyRawOutput(session: PTYSessionInfo, rawData: string): void {
  for (const callback of rawOutputCallbacks) {
    try {
      callback(session, rawData)
    } catch {
      // Ignore callback errors
    }
  }
}

class PTYManager {
  private lifecycleManager = new SessionLifecycleManager()
  private outputManager = new OutputManager()
  private notificationManager = new NotificationManager()
  private nudgeManager = new NudgeManager()

  init(client: OpencodeClient): void {
    this.notificationManager.init(client)
    this.nudgeManager.init(client)
  }

  clearAllSessions(): void {
    for (const session of this.lifecycleManager.listSessions()) {
      this.nudgeManager.clearNudge(session)
    }
    this.lifecycleManager.clearAllSessions()
  }

  spawn(opts: SpawnOptions): PTYSessionInfo {
    const initialSession = this.lifecycleManager.spawn(
      opts,
      (session, data) => {
        notifyRawOutput(this.lifecycleManager.toInfo(session), data)
      },
      async (session, exitCode) => {
        this.nudgeManager.clearNudge(session)
        notifySessionUpdate(this.lifecycleManager.toInfo(session))
        if (session?.notifyOnExit) {
          await this.notificationManager.sendExitNotification(session, exitCode || 0)
        }
      }
    )
    const rawSession = this.lifecycleManager.getSession(initialSession.id)
    if (rawSession) {
      this.nudgeManager.startNudge(rawSession)
    }
    const session = rawSession ? this.lifecycleManager.toInfo(rawSession) : initialSession
    notifySessionUpdate(session)
    return session
  }

  write(id: string, data: string): boolean {
    const result = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.write(session, data),
      false
    )
    if (result) {
      const session = this.lifecycleManager.getSession(id)
      if (session) {
        this.nudgeManager.recordManualActivity(session)
      }
    }
    return result
  }

  read(id: string, offset: number = 0, limit?: number): ReadResult | null {
    const result = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.read(session, offset, limit),
      null
    )
    const session = this.lifecycleManager.getSession(id)
    if (result && session) {
      this.nudgeManager.recordManualActivity(session)
    }
    return result
  }

  search(id: string, pattern: RegExp, offset: number = 0, limit?: number): SearchResult | null {
    const result = withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.search(session, pattern, offset, limit),
      null
    )
    const session = this.lifecycleManager.getSession(id)
    if (result && session) {
      this.nudgeManager.recordManualActivity(session)
    }
    return result
  }

  list(): PTYSessionInfo[] {
    return this.lifecycleManager.listSessions().map((s) => this.lifecycleManager.toInfo(s))
  }

  get(id: string): PTYSessionInfo | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.lifecycleManager.toInfo(session),
      null
    )
  }

  getRawBuffer(id: string): { raw: string; byteLength: number } | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => ({
        raw: session.buffer.readRaw(),
        byteLength: session.buffer.byteLength,
      }),
      null
    )
  }

  kill(id: string, cleanup: boolean = false): boolean {
    const session = this.lifecycleManager.getSession(id)
    if (session) {
      this.nudgeManager.clearNudge(session)
    }
    return this.lifecycleManager.kill(id, cleanup)
  }

  cleanupBySession(parentSessionId: string): void {
    this.nudgeManager.clearByParentSession(parentSessionId)
    this.lifecycleManager.cleanupBySession(parentSessionId)
  }

  handleParentSessionStatus(parentSessionId: string, status: ParentSessionStatus): void {
    this.nudgeManager.handleParentSessionStatus(parentSessionId, status)
  }

  handleParentAssistantMessage(
    parentSessionId: string,
    completed: boolean,
    errorName: string | undefined
  ): void {
    this.nudgeManager.handleParentAssistantMessage(parentSessionId, completed, errorName)
  }

  handleParentSessionError(parentSessionId: string): void {
    this.nudgeManager.handleParentSessionError(parentSessionId)
  }

  pauseNudgesByParentSession(parentSessionId: string): string[] {
    const paused: string[] = []
    for (const session of this.lifecycleManager.listSessions()) {
      if (
        session.parentSessionId !== parentSessionId ||
        session.status !== 'running' ||
        !session.nudgeEnabled ||
        (session.nudgePaused && session.nudgeOneShotDelaySeconds === undefined)
      ) {
        continue
      }
      this.nudgeManager.configureNudge(session, 'pause')
      notifySessionUpdate(this.lifecycleManager.toInfo(session))
      paused.push(session.id)
    }
    return paused
  }

  configureNudge(id: string, action: NudgeAction, seconds?: number): PTYSessionInfo | null {
    const session = this.lifecycleManager.getSession(id)
    if (!session) {
      return null
    }
    this.nudgeManager.configureNudge(session, action, seconds)
    const info = this.lifecycleManager.toInfo(session)
    notifySessionUpdate(info)
    return info
  }
}

export const manager = new PTYManager()

export function initManager(opcClient: OpencodeClient): void {
  manager.init(opcClient)
}
