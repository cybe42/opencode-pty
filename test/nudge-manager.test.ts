import { describe, expect, it, mock } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import {
  AUTOMATIC_NUDGE_INTERVAL_SECONDS,
  NudgeManager as BaseNudgeManager,
  type NudgeClock,
} from '../src/plugin/pty/nudge-manager.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'

type TimerHandle = ReturnType<typeof setTimeout>

class NudgeManager extends BaseNudgeManager {
  override init(client: OpencodeClient): void {
    super.init(client)
    this.handleParentAssistantMessage('parent-session', true, undefined)
    this.handleParentSessionStatus('parent-session', 'idle')
  }
}

class FakeClock implements NudgeClock {
  private currentTime = 0
  private nextId = 1
  private tasks = new Map<number, { dueAt: number; callback: () => void }>()
  readonly delayHistory: number[] = []

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++
    this.tasks.set(id, { dueAt: this.currentTime + delayMs, callback })
    this.delayHistory.push(delayMs)
    return id as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks.delete(handle as unknown as number)
  }

  async advanceBy(milliseconds: number): Promise<void> {
    const targetTime = this.currentTime + milliseconds
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= targetTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0]
      if (!next) {
        break
      }

      const [id, task] = next
      this.tasks.delete(id)
      this.currentTime = task.dueAt
      task.callback()
      await settleAsyncWork()
    }

    this.currentTime = targetTime
    await settleAsyncWork()
  }

  get pendingTaskCount(): number {
    return this.tasks.size
  }
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

function createSession(id: string, overrides: Partial<PTYSession> = {}): PTYSession {
  return {
    id,
    title: `Session ${id}`,
    description: `Description ${id}`,
    command: 'sleep',
    args: ['60'],
    workdir: '/tmp',
    status: 'running',
    pid: 1234,
    createdAt: new Date(0),
    lastOutputAt: undefined,
    parentSessionId: 'parent-session',
    parentAgent: 'test-agent',
    notifyOnExit: false,
    timeoutSeconds: undefined,
    timedOut: false,
    nudgeEnabled: true,
    nudgePolicy: 'automatic',
    nudgePaused: false,
    nudgeAutomaticStep: 0,
    nudgeIntervalSeconds: undefined,
    nudgeOneShotDelaySeconds: undefined,
    nudgeNextDueAt: undefined,
    nudgeLastOutputPosition: 0,
    nudgeGeneration: 0,
    buffer: new RingBuffer(),
    process: null,
    ...overrides,
  }
}

function createClient(statuses: Record<string, { type: 'idle' | 'busy' | 'retry' }> = {}) {
  const promptAsync = mock(async (_payload: unknown) => {})
  const status = mock(async () => ({ data: statuses }))
  const get = mock(async () => ({ data: {} }))
  return {
    client: { session: { promptAsync, status, get } } as unknown as OpencodeClient,
    promptAsync,
    status,
    statuses,
  }
}

function getPromptText(promptAsync: ReturnType<typeof mock>, index: number): string {
  const payload = promptAsync.mock.calls[index]?.[0] as
    | { body?: { parts?: Array<{ text?: string }> } }
    | undefined
  return payload?.body?.parts?.[0]?.text ?? ''
}

function completeParentTurn(manager: BaseNudgeManager, session: PTYSession): void {
  manager.handleParentAssistantMessage(session.parentSessionId, true, undefined)
  manager.handleParentSessionStatus(session.parentSessionId, 'idle')
}

describe('NudgeManager', () => {
  it('uses the automatic cadence and remains at 30 minutes at the final step', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_automatic')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    for (const [index, interval] of AUTOMATIC_NUDGE_INTERVAL_SECONDS.entries()) {
      await clock.advanceBy(interval * 1000 + 25)
      if (index < AUTOMATIC_NUDGE_INTERVAL_SECONDS.length - 1) {
        completeParentTurn(manager, session)
      }
    }

    expect(promptAsync).toHaveBeenCalledTimes(AUTOMATIC_NUDGE_INTERVAL_SECONDS.length)
    expect(clock.delayHistory.filter((delay) => delay >= 1000)).toEqual(
      AUTOMATIC_NUDGE_INTERVAL_SECONDS.map((seconds) => seconds * 1000)
    )
    expect(session.nudgeAutomaticStep).toBe(6)
    expect(session.nudgeNextDueAt).toBeUndefined()
    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 1_800_000)
    expect(getPromptText(promptAsync, 0)).toContain('After This Nudge: automatic in 60s')
  })

  it('uses a spawn-selected recurring cadence without advancing automatic state', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_recurring', {
      nudgePolicy: 'recurring',
      nudgeIntervalSeconds: 300,
    })
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(300_025)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeAutomaticStep).toBe(0)
    expect(session.nudgeNextDueAt).toBeUndefined()
    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 300_000)
    expect(getPromptText(promptAsync, 0)).toContain('Nudge Trigger: recurring every 300s')
  })

  it('applies a one-shot override and then resumes automatic mode', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_one_shot')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    manager.configureNudge(session, 'next', 600)
    expect(session.nudgeOneShotDelaySeconds).toBe(600)
    expect(session.nudgeNextDueAt).toBe(600_000)
    await clock.advanceBy(600_025)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeOneShotDelaySeconds).toBeUndefined()
    expect(session.nudgeAutomaticStep).toBe(1)
    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 60_000)
    expect(getPromptText(promptAsync, 0)).toContain('Nudge Trigger: one-shot override after 600s')
  })

  it('preserves recurring policy across pause and resume', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_pause', {
      nudgePolicy: 'recurring',
      nudgeIntervalSeconds: 900,
    })
    manager.init(client)
    manager.startNudge(session)

    manager.configureNudge(session, 'pause')
    expect(session.nudgePaused).toBe(true)
    expect(session.nudgePolicy).toBe('recurring')
    expect(session.nudgeIntervalSeconds).toBe(900)
    expect(session.nudgeNextDueAt).toBeUndefined()

    manager.configureNudge(session, 'resume')
    expect(session.nudgePaused).toBe(false)
    expect(session.nudgePolicy).toBe('recurring')
    expect(session.nudgeNextDueAt).toBe(clock.now() + 900_000)
  })

  it('allows one nudge while paused and returns to paused', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_paused_once')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)
    manager.configureNudge(session, 'pause')
    manager.configureNudge(session, 'next', 30)

    await clock.advanceBy(30_025)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgePaused).toBe(true)
    expect(session.nudgeOneShotDelaySeconds).toBeUndefined()
    expect(session.nudgeNextDueAt).toBeUndefined()
    expect(getPromptText(promptAsync, 0)).toContain('After This Nudge: paused until resumed')
  })

  it('lets every and automatic select a policy while resuming', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_select_policy')
    manager.init(client)
    manager.startNudge(session)
    manager.configureNudge(session, 'pause')

    manager.configureNudge(session, 'every', 1200)
    expect(session.nudgePaused).toBe(false)
    expect(session.nudgePolicy).toBe('recurring')
    expect(session.nudgeNextDueAt).toBe(clock.now() + 1_200_000)

    manager.configureNudge(session, 'pause')
    manager.configureNudge(session, 'automatic')
    expect(session.nudgePaused).toBe(false)
    expect(session.nudgePolicy).toBe('automatic')
    expect(session.nudgeAutomaticStep).toBe(0)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 30_000)
  })

  it('postpones automatic mode but leaves explicit schedules unchanged on manual activity', async () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_manual')
    manager.init(client)
    manager.startNudge(session)

    await clock.advanceBy(15_000)
    session.buffer.append('checked\n')
    manager.recordManualActivity(session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 30_000)
    expect(session.nudgeLastOutputPosition).toBe(session.buffer.position)

    manager.configureNudge(session, 'every', 300)
    const recurringDueAt = session.nudgeNextDueAt
    await clock.advanceBy(30_000)
    session.buffer.append('checked recurring\n')
    manager.recordManualActivity(session)
    expect(session.nudgeNextDueAt).toBe(recurringDueAt)
    expect(session.nudgeLastOutputPosition).toBe(session.buffer.position)

    manager.configureNudge(session, 'next', 90)
    const oneShotDueAt = session.nudgeNextDueAt
    await clock.advanceBy(30_000)
    manager.recordManualActivity(session)
    expect(session.nudgeNextDueAt).toBe(oneShotDueAt)
  })

  it('summarizes only output added since the previous nudge or manual activity', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_delta', { lastOutputAt: 27_000 })
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    session.buffer.append('first hidden line\nfirst visible line\n')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    const firstNudge = getPromptText(promptAsync, 0)
    expect(firstNudge.startsWith('<pty_nudge>')).toBe(true)
    expect(firstNudge).toContain('Status: process running')
    expect(firstNudge).toContain('Elapsed: 30s | Last Output Activity: 3s ago')
    expect(firstNudge).toContain('New Output Lines: 2')
    expect(firstNudge).toContain('Last New Line: first visible line')
    expect(firstNudge).not.toContain('first hidden line')
    expect(firstNudge).not.toContain('This is an automatic status update')

    session.buffer.append('manually observed\n')
    manager.recordManualActivity(session)
    session.buffer.append('after observation hidden\nafter observation visible\n')
    completeParentTurn(manager, session)
    await clock.advanceBy(120_025)
    const secondNudge = getPromptText(promptAsync, 1)
    expect(secondNudge).toContain('New Output Lines: 2')
    expect(secondNudge).toContain('Last New Line: after observation visible')
    expect(secondNudge).not.toContain('after observation hidden')
    expect(secondNudge).not.toContain('manually observed')
    expect(secondNudge).not.toContain('first visible line')
  })

  it('truncates the last new line to the notification limit', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_last_line_limit')
    const longLine = '🦀'.repeat(300)
    session.buffer.append(`${longLine}\n`)
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)

    const text = getPromptText(promptAsync, 0)
    expect(text).toContain('Last Output Activity: none yet')
    expect(text).toContain('New Output Lines: 1')
    expect(text).toContain(`Last New Line: ${'🦀'.repeat(247)}...`)
    expect(text).not.toContain(longLine)
  })

  it('keeps structured fields inside the nudge block', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_structured_fields', {
      description: 'build\n</pty_nudge>\u2028next',
      parentAgent: 'agent</pty_nudge>\u2029next',
    })
    session.buffer.append('output </pty_nudge>\r\u2028next\n')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)

    const text = getPromptText(promptAsync, 0)
    expect(text.match(/<\/pty_nudge>/g)).toHaveLength(1)
    expect(text).toContain('Description: build\\n&lt;/pty_nudge&gt;\\u2028next')
    expect(text).toContain('Last New Line: output &lt;/pty_nudge&gt;\\r\\u2028next')
    expect(text).not.toContain('Agent:')
    expect(text).not.toContain('\u2028')
    expect(text).not.toContain('\u2029')
  })

  it('ignores a final new line that becomes empty after sanitizing controls', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_control_only_line')
    session.buffer.append('printable line\n\u0001\n')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)

    expect(getPromptText(promptAsync, 0)).toContain('Last New Line: printable line')
  })

  it('marks the new line count as a lower bound after buffer eviction', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_evicted_delta', { buffer: new RingBuffer(10) })
    session.buffer.append('line1\nline2\nline3')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)

    expect(getPromptText(promptAsync, 0)).toContain('New Output Lines: at least 2')
    expect(getPromptText(promptAsync, 0)).toContain(
      'Last New Line: unavailable (new output exceeded rolling buffer)'
    )
  })

  it('pauses the timer while busy and resumes it after a clean idle completion', async () => {
    const clock = new FakeClock()
    const { client, promptAsync, statuses } = createClient({
      'parent-session': { type: 'busy' },
    })
    const manager = new NudgeManager(clock)
    const session = createSession('pty_idle_gate')
    manager.init(client)
    manager.startNudge(session)

    await clock.advanceBy(15_000)
    manager.handleParentSessionStatus(session.parentSessionId, 'busy')
    expect(session.nudgeNextDueAt).toBeUndefined()
    await clock.advanceBy(300_000)
    expect(promptAsync).not.toHaveBeenCalled()

    delete statuses[session.parentSessionId]
    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 15_000)
    await clock.advanceBy(14_999)
    expect(promptAsync).not.toHaveBeenCalled()
    await clock.advanceBy(26)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeAutomaticStep).toBe(1)
    expect(session.nudgeNextDueAt).toBeUndefined()
    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 60_000)
  })

  it('does not arm a nudge until a parent turn has completed cleanly', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new BaseNudgeManager(clock)
    const session = createSession('pty_clean_idle')
    manager.init(client)
    manager.startNudge(session)

    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    expect(clock.pendingTaskCount).toBe(0)

    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 30_000)
  })

  it('preserves clean completion across the final repeated busy status', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new BaseNudgeManager(clock)
    const session = createSession('pty_final_busy')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'busy')
    manager.startNudge(session)

    manager.handleParentAssistantMessage(session.parentSessionId, true, undefined)
    manager.handleParentSessionStatus(session.parentSessionId, 'busy')
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')

    expect(session.nudgeNextDueAt).toBe(clock.now() + 30_000)
  })

  it('requires a new clean completion after idle transitions to busy', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_new_busy_turn')
    manager.init(client)
    manager.startNudge(session)

    manager.handleParentSessionStatus(session.parentSessionId, 'busy')
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')

    expect(session.nudgeNextDueAt).toBeUndefined()
    expect(clock.pendingTaskCount).toBe(0)
  })

  it('suppresses pending nudges after a non-clean parent outcome', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_nonclean')
    manager.init(client)
    manager.startNudge(session)

    await clock.advanceBy(30_000)
    manager.handleParentAssistantMessage(session.parentSessionId, true, 'MessageAbortedError')
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    await clock.advanceBy(25)

    expect(promptAsync).not.toHaveBeenCalled()
    expect(session.nudgeNextDueAt).toBeUndefined()

    completeParentTurn(manager, session)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 30_000)
  })

  it('allows recurring intervals longer than the automatic 30-minute cap', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_long_recurring')
    manager.init(client)
    manager.startNudge(session)

    manager.configureNudge(session, 'every', 7_200)
    expect(session.nudgeNextDueAt).toBe(clock.now() + 7_200_000)
  })

  it('batches sessions due at the same idle moment into one prompt', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const first = createSession('pty_first')
    const second = createSession('pty_second')
    manager.init(client)
    manager.handleParentSessionStatus(first.parentSessionId, 'idle')
    manager.startNudge(first)
    manager.startNudge(second)

    await clock.advanceBy(60_025)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const text = getPromptText(promptAsync, 0)
    expect(text.match(/<pty_nudge>/g)).toHaveLength(2)
    expect(text.startsWith('<pty_nudge>')).toBe(true)
    expect(text).not.toContain('This is an automatic status update')
    expect(text).toContain('ID: pty_first')
    expect(text).toContain('ID: pty_second')
  })

  it('omits prompt-level agent targeting for mixed-agent batches', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const first = createSession('pty_agent_one', { parentAgent: 'agent-one' })
    const second = createSession('pty_agent_two', { parentAgent: 'agent-two' })
    manager.init(client)
    manager.handleParentSessionStatus(first.parentSessionId, 'idle')
    manager.startNudge(first)
    manager.startNudge(second)

    await clock.advanceBy(60_025)

    const payload = promptAsync.mock.calls[0]?.[0] as
      | { body?: { agent?: string; parts?: Array<{ text?: string }> } }
      | undefined
    expect(payload?.body && Object.hasOwn(payload.body, 'agent')).toBe(false)
    expect(payload?.body?.parts?.[0]?.text).not.toContain('Agent:')
  })

  it('rechecks conflicting idle events and busy status responses', async () => {
    const clock = new FakeClock()
    const { client, promptAsync, status } = createClient()
    let resolveStatus: ((value: { data: Record<string, { type: 'busy' }> }) => void) | undefined
    status.mockImplementationOnce(
      async () =>
        await new Promise<{ data: Record<string, { type: 'busy' }> }>((resolve) => {
          resolveStatus = resolve
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_status_race')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    manager.handleParentSessionStatus(session.parentSessionId, 'busy')
    completeParentTurn(manager, session)
    resolveStatus?.({ data: { [session.parentSessionId]: { type: 'busy' } } })
    await settleAsyncWork()

    expect(promptAsync).not.toHaveBeenCalled()
    await clock.advanceBy(5_000)
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  it('drops a snapshot invalidated during the final status check', async () => {
    const clock = new FakeClock()
    const { client, promptAsync, status } = createClient()
    let resolveFinalStatus: ((value: { data: Record<string, never> }) => void) | undefined
    status.mockImplementationOnce(async () => ({ data: {} }))
    status.mockImplementationOnce(
      async () =>
        await new Promise<{ data: Record<string, never> }>((resolve) => {
          resolveFinalStatus = resolve
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_final_check_race')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    manager.configureNudge(session, 'pause')
    resolveFinalStatus?.({ data: {} })
    await settleAsyncWork()

    expect(promptAsync).not.toHaveBeenCalled()
    expect(session.nudgePaused).toBe(true)
  })

  it('rebuilds a due recurring snapshot after manual activity', async () => {
    const clock = new FakeClock()
    const { client, promptAsync, status } = createClient()
    let resolveFinalStatus: ((value: { data: Record<string, never> }) => void) | undefined
    status.mockImplementationOnce(async () => ({ data: {} }))
    status.mockImplementationOnce(
      async () =>
        await new Promise<{ data: Record<string, never> }>((resolve) => {
          resolveFinalStatus = resolve
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_manual_snapshot', {
      nudgePolicy: 'recurring',
      nudgeIntervalSeconds: 60,
    })
    session.buffer.append('already consumed\n')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    manager.recordManualActivity(session)
    resolveFinalStatus?.({ data: {} })
    await settleAsyncWork()
    await clock.advanceBy(25)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(getPromptText(promptAsync, 0)).toContain('New Output Lines: 0')
    expect(getPromptText(promptAsync, 0)).toContain('Last New Line: ')
    expect(getPromptText(promptAsync, 0)).not.toContain('already consumed')
    expect(session.nudgeNextDueAt).toBeUndefined()
  })

  it('does not duplicate a nudge after prompt submission begins', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    let resolvePrompt: (() => void) | undefined
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    promptAsync.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve
          markPromptStarted?.()
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_submitting', {
      nudgePolicy: 'recurring',
      nudgeIntervalSeconds: 60,
    })
    session.buffer.append('submitted output\n')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    await promptStarted
    const generation = session.nudgeGeneration
    manager.recordManualActivity(session)
    expect(session.nudgeGeneration).toBe(generation)
    resolvePrompt?.()
    await settleAsyncWork()
    await clock.advanceBy(25)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeNextDueAt).toBeUndefined()
  })

  it('postpones automatic mode from in-flight manual activity when submission fails', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    let rejectPrompt: ((error: Error) => void) | undefined
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    promptAsync.mockImplementationOnce(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject
          markPromptStarted?.()
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_failed_submission')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    await promptStarted
    manager.recordManualActivity(session)
    rejectPrompt?.(new Error('Prompt rejected'))
    await settleAsyncWork()

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeAutomaticStep).toBe(0)
    expect(session.nudgeNextDueAt).toBe(90_025)
    await clock.advanceBy(29_999)
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  it('does not let an old submission shadow a newly configured generation', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    let resolvePrompt: (() => void) | undefined
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    promptAsync.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve
          markPromptStarted?.()
        })
    )
    const manager = new NudgeManager(clock)
    const session = createSession('pty_new_generation')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(60_025)
    await promptStarted
    manager.configureNudge(session, 'automatic')
    await clock.advanceBy(10_000)
    manager.recordManualActivity(session)
    expect(session.nudgeNextDueAt).toBe(100_025)

    resolvePrompt?.()
    await settleAsyncWork()
    expect(session.nudgeNextDueAt).toBe(100_025)
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  it('retries status and prompt failures without advancing policy or cursor', async () => {
    const clock = new FakeClock()
    const { client, promptAsync, status } = createClient()
    status.mockImplementationOnce(async () => {
      throw new Error('Status API unavailable')
    })
    promptAsync.mockImplementationOnce(async () => {
      throw new Error('Prompt rejected')
    })
    const manager = new NudgeManager(clock)
    const session = createSession('pty_retry')
    session.buffer.append('must remain pending\n')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(30_025)
    expect(promptAsync).not.toHaveBeenCalled()
    await clock.advanceBy(5_000)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(session.nudgeAutomaticStep).toBe(0)
    expect(session.nudgeLastOutputPosition).toBe(0)

    await clock.advanceBy(5_000)
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(session.nudgeAutomaticStep).toBe(1)
    expect(session.nudgeLastOutputPosition).toBe(session.buffer.position)
  })

  it('validates control arguments without destroying the existing schedule', () => {
    const clock = new FakeClock()
    const { client } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_validation')
    manager.init(client)
    manager.startNudge(session)
    const dueAt = session.nudgeNextDueAt

    expect(() => manager.configureNudge(session, 'next')).toThrow('seconds must be')
    expect(() => manager.configureNudge(session, 'pause', 10)).toThrow('seconds is not used')
    expect(() => manager.configureNudge(session, 'every', 2_147_484)).toThrow(
      'no greater than 2147483'
    )
    expect(session.nudgeNextDueAt).toBe(dueAt)
  })

  it('does not schedule nudges for non-agent web sessions', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_disabled', { nudgeEnabled: false })
    manager.init(client)
    manager.startNudge(session)

    expect(clock.pendingTaskCount).toBe(0)
    await clock.advanceBy(1_000_000)
    expect(promptAsync).not.toHaveBeenCalled()
  })

  it('clears the timer and pending delivery when a session ends', async () => {
    const clock = new FakeClock()
    const { client, promptAsync } = createClient()
    const manager = new NudgeManager(clock)
    const session = createSession('pty_cleanup')
    manager.init(client)
    manager.handleParentSessionStatus(session.parentSessionId, 'idle')
    manager.startNudge(session)

    await clock.advanceBy(30_000)
    session.status = 'killed'
    manager.clearNudge(session)

    expect(clock.pendingTaskCount).toBe(0)
    expect(promptAsync).not.toHaveBeenCalled()
  })
})
