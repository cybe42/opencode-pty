import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { PTYPlugin } from '../src/plugin.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import type { PluginContext } from '../src/plugin/types.ts'

type CommandHook = (input: {
  command: string
  sessionID: string
  arguments: string
}) => Promise<void>

function createClient(statuses: Record<string, { type: 'idle' | 'busy' | 'retry' }> = {}) {
  const prompt = mock(async (_input: unknown) => ({}))
  const showToast = mock(async (_input: unknown) => ({}))
  const status = mock(async (_input: unknown) => ({ data: statuses }))
  return {
    client: {
      session: { prompt, status },
      tui: { showToast },
    } as unknown as PluginContext['client'],
    prompt,
    showToast,
  }
}

describe('/stopnudges command', () => {
  afterEach(() => {
    mock.restore()
  })

  it('registers the command', async () => {
    const { client } = createClient()
    const plugin = await PTYPlugin({ client, directory: '/tmp' } as PluginContext)
    const config = { command: {} } as { command: Record<string, unknown> }

    await plugin.config?.(config as never)

    expect(config.command.stopnudges).toEqual({
      template: 'Pause all PTY nudges for this chat without stopping the processes.',
      description: 'Stop PTY nudges for this chat',
    })
  })

  it('pauses nudges when the parent chat is idle', async () => {
    const { client, prompt, showToast } = createClient()
    const pause = spyOn(manager, 'pauseNudgesByParentSession').mockReturnValue([
      'pty_a1b2c3d4',
      'pty_e5f6g7h8',
    ])
    const plugin = await PTYPlugin({ client, directory: '/tmp' } as PluginContext)
    const hook = plugin['command.execute.before'] as CommandHook

    await expect(
      hook({ command: 'stopnudges', sessionID: 'parent-session', arguments: '' })
    ).rejects.toThrow('Command handled by PTY plugin')

    expect(pause).toHaveBeenCalledWith('parent-session')
    expect(prompt).toHaveBeenCalledWith({
      path: { id: 'parent-session' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            text: [
              '<pty_nudge>',
              'ID: pty_a1b2c3d4, pty_e5f6g7h8',
              'Nudge Status: paused by user',
              'Resume with: pty_nudge(id="...", action="resume")',
              '</pty_nudge>',
            ].join('\n'),
          },
        ],
      },
    })
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'PTY Nudges',
        message: 'Paused nudges for 2 PTY processes.',
        variant: 'success',
        duration: 3000,
      },
    })
  })

  it('does not pause nudges while the parent chat is busy', async () => {
    const { client, prompt, showToast } = createClient({ 'parent-session': { type: 'busy' } })
    const pause = spyOn(manager, 'pauseNudgesByParentSession').mockReturnValue(['pty_a1b2c3d4'])
    const plugin = await PTYPlugin({ client, directory: '/tmp' } as PluginContext)
    const hook = plugin['command.execute.before'] as CommandHook

    await expect(
      hook({ command: 'stopnudges', sessionID: 'parent-session', arguments: '' })
    ).rejects.toThrow('Command handled by PTY plugin')

    expect(pause).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'PTY Nudges',
        message: 'Cannot stop PTY nudges while this chat is busy.',
        variant: 'error',
        duration: 3000,
      },
    })
  })
})
