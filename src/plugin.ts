import type { PluginContext, PluginResult } from './plugin/types.ts'
import { initManager, manager } from './plugin/pty/manager.ts'
import { initPermissions } from './plugin/pty/permissions.ts'
import { ptySpawn } from './plugin/pty/tools/spawn.ts'
import { ptyWrite } from './plugin/pty/tools/write.ts'
import { ptyRead } from './plugin/pty/tools/read.ts'
import { ptyList } from './plugin/pty/tools/list.ts'
import { ptyKill } from './plugin/pty/tools/kill.ts'
import { ptyNudge } from './plugin/pty/tools/nudge.ts'
import { PTYServer } from './web/server/server.ts'
import open from 'open'

const ptyOpenClientCommand = 'pty-open-background-spy'
const ptyShowServerUrlCommand = 'pty-show-server-url'
const stopNudgesCommand = 'stopnudges'

export const PTYPlugin = async ({ client, directory }: PluginContext): Promise<PluginResult> => {
  initPermissions(client, directory)
  initManager(client)
  let ptyServer: PTYServer | undefined

  return {
    'command.execute.before': async (input) => {
      if (
        input.command !== ptyOpenClientCommand &&
        input.command !== ptyShowServerUrlCommand &&
        input.command !== stopNudgesCommand
      ) {
        return
      }
      if (input.command === stopNudgesCommand) {
        const response = await client.session.status({ throwOnError: true })
        const statuses = response.data as
          | Record<string, { type: 'idle' | 'busy' | 'retry' }>
          | undefined
        const status = statuses?.[input.sessionID]?.type ?? 'idle'
        const pausedIds =
          status === 'idle' ? manager.pauseNudgesByParentSession(input.sessionID) : undefined
        const paused = pausedIds?.length
        if (pausedIds && pausedIds.length > 0) {
          await client.session.prompt({
            path: { id: input.sessionID },
            body: {
              noReply: true,
              parts: [
                {
                  type: 'text',
                  text: [
                    '<pty_nudge>',
                    `ID: ${pausedIds.join(', ')}`,
                    'Nudge Status: paused by user',
                    'Resume with: pty_nudge(id="...", action="resume")',
                    '</pty_nudge>',
                  ].join('\n'),
                },
              ],
            },
          })
        }
        await client.tui.showToast({
          body: {
            title: 'PTY Nudges',
            message:
              paused === undefined
                ? 'Cannot stop PTY nudges while this chat is busy.'
                : paused === 0
                  ? 'No active PTY nudges to stop.'
                  : `Paused nudges for ${paused} PTY ${paused === 1 ? 'process' : 'processes'}.`,
            variant: paused === undefined ? 'error' : paused === 0 ? 'info' : 'success',
            duration: 3000,
          },
        })
        throw new Error('Command handled by PTY plugin')
      }
      if (ptyServer === undefined) {
        ptyServer = await PTYServer.createServer()
      }
      if (input.command === ptyOpenClientCommand) {
        open(ptyServer.server.url.origin)
      } else if (input.command === ptyShowServerUrlCommand) {
        const message = `PTY Sessions Web Interface URL: ${ptyServer.server.url.origin}`
        await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: 'text',
                text: message,
              },
            ],
          },
        })
      }
      throw new Error('Command handled by PTY plugin')
    },
    tool: {
      pty_spawn: ptySpawn,
      pty_write: ptyWrite,
      pty_read: ptyRead,
      pty_list: ptyList,
      pty_kill: ptyKill,
      pty_nudge: ptyNudge,
    },
    config: async (input) => {
      if (!input.command) {
        input.command = {}
      }
      input.command[ptyOpenClientCommand] = {
        template: `This command will start the PTY Sessions Web Interface in your default browser.`,
        description: 'Open PTY Sessions Web Interface',
      }
      input.command[ptyShowServerUrlCommand] = {
        template: `This command will show the PTY Sessions Web Interface URL.`,
        description: 'Show PTY Sessions Web Interface URL',
      }
      input.command[stopNudgesCommand] = {
        template: `Pause all PTY nudges for this chat without stopping the processes.`,
        description: 'Stop PTY nudges for this chat',
      }
    },
    event: async ({ event }) => {
      if (event.type === 'message.updated') {
        const { info } = event.properties
        if (info.role === 'assistant') {
          manager.handleParentAssistantMessage(
            info.sessionID,
            info.time.completed !== undefined,
            info.error?.name
          )
        }
      } else if (event.type === 'session.error') {
        if (event.properties.sessionID) {
          manager.handleParentSessionError(event.properties.sessionID)
        }
      } else if (event.type === 'session.status') {
        manager.handleParentSessionStatus(event.properties.sessionID, event.properties.status.type)
      } else if (event.type === 'session.deleted') {
        manager.cleanupBySession(event.properties.info.id)
      }
    },
  }
}
