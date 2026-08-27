import { describe, expect, it, spyOn } from 'bun:test'
import {
  manager,
  registerSessionUpdateCallback,
  removeSessionUpdateCallback,
} from '../src/plugin/pty/manager.ts'
import { NudgeManager } from '../src/plugin/pty/nudge-manager.ts'

describe('nudge lifecycle wiring', () => {
  it('clears nudge state when a session exits naturally', async () => {
    const clearNudge = spyOn(NudgeManager.prototype, 'clearNudge')
    const title = crypto.randomUUID()
    const exited = new Promise<void>((resolve) => {
      const callback = (session: { title: string; status: string }) => {
        if (session.title === title && session.status === 'exited') {
          removeSessionUpdateCallback(callback)
          resolve()
        }
      }
      registerSessionUpdateCallback(callback)
    })

    const session = manager.spawn({
      command: 'echo',
      args: ['done'],
      title,
      description: 'Natural exit nudge cleanup',
      parentSessionId: 'nudge-lifecycle-test',
      nudgeIntervalSeconds: 600,
    })

    await exited
    expect(clearNudge.mock.calls.some(([value]) => value.id === session.id)).toBe(true)
    manager.kill(session.id, true)
    clearNudge.mockRestore()
  })

  it('clears nudge state when a session is killed', () => {
    const clearNudge = spyOn(NudgeManager.prototype, 'clearNudge')
    const session = manager.spawn({
      command: 'sleep',
      args: ['60'],
      description: 'Explicit kill nudge cleanup',
      parentSessionId: 'nudge-lifecycle-test',
      nudgeIntervalSeconds: 600,
    })

    expect(manager.kill(session.id, true)).toBe(true)
    expect(clearNudge.mock.calls.some(([value]) => value.id === session.id)).toBe(true)
    clearNudge.mockRestore()
  })

  it('routes manager reads and writes through manual nudge activity', () => {
    const recordManualActivity = spyOn(NudgeManager.prototype, 'recordManualActivity')
    const session = manager.spawn({
      command: 'sleep',
      args: ['60'],
      description: 'Manual activity nudge wiring',
      parentSessionId: 'nudge-lifecycle-test',
    })

    manager.read(session.id)
    manager.write(session.id, '')

    expect(
      recordManualActivity.mock.calls.filter(([value]) => value.id === session.id)
    ).toHaveLength(2)
    manager.kill(session.id, true)
    recordManualActivity.mockRestore()
  })

  it('pauses nudges for running PTYs owned by one parent session', () => {
    const parentSessionId = crypto.randomUUID()
    const session = manager.spawn({
      command: 'sleep',
      args: ['60'],
      description: 'Session-wide nudge pause wiring',
      parentSessionId,
    })

    expect(manager.pauseNudgesByParentSession(parentSessionId)).toEqual([session.id])
    expect(manager.get(session.id)?.nudgePaused).toBe(true)
    expect(manager.pauseNudgesByParentSession(parentSessionId)).toEqual([])

    manager.kill(session.id, true)
  })

  it('rejects spawn intervals beyond the timer-safe range', () => {
    expect(() =>
      manager.spawn({
        command: 'echo',
        args: ['never spawned'],
        description: 'Invalid nudge interval',
        parentSessionId: 'nudge-lifecycle-test',
        nudgeIntervalSeconds: 2_147_484,
      })
    ).toThrow('nudgeIntervalSeconds must not exceed 2147483 seconds')
  })
})
