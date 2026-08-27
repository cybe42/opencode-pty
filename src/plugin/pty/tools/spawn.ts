import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../permissions.ts'
import { formatNudgeSummary } from '../formatters.ts'
import DESCRIPTION from './spawn.txt'

const NOTIFY_ON_EXIT_INSTRUCTIONS = [
  `<system_reminder>`,
  `Completion signal for this session is the future \`<pty_exited>\` message.`,
  `If you only need to know whether the command finished, do not call \`pty_read\`; wait for \`<pty_exited>\`.`,
  `Never use sleep plus \`pty_read\` loops to check completion for this session.`,
  `Call \`pty_read\` before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.`,
  `</system_reminder>`,
].join('\n')

const NUDGE_INSTRUCTIONS = [
  `<system_reminder>`,
  `Future \`<pty_nudge>\` messages mean this PTY is still running; they are not completion signals.`,
  `Use your judgment to inspect it with \`pty_read\`, manage future check-ins with \`pty_nudge\`, leave it running, or stop it.`,
  `Avoid sleep-and-\`pty_read\` polling loops; nudges can be used for future check-ins instead.`,
  `</system_reminder>`,
].join('\n')

export const ptySpawn = tool({
  description: DESCRIPTION,
  args: {
    command: tool.schema.string().describe('The command/executable to run'),
    args: tool.schema.array(tool.schema.string()).describe('Arguments to pass to the command'),
    workdir: tool.schema.string().optional().describe('Working directory for the PTY session'),
    env: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe('Additional environment variables'),
    title: tool.schema.string().optional().describe('Human-readable title for the session'),
    description: tool.schema
      .string()
      .describe('Clear, concise description of what this PTY session is for in 5-10 words'),
    notifyOnExit: tool.schema
      .boolean()
      .optional()
      .describe(
        'If true, sends a notification to the session when the process exits (default: false)'
      ),
    timeoutSeconds: tool.schema
      .number()
      .optional()
      .describe(
        'Optional per-session timeout in seconds. The PTY is killed automatically when this duration elapses.'
      ),
    nudgeIntervalSeconds: tool.schema
      .number()
      .optional()
      .describe(
        'Optional initial recurring nudge cadence in seconds. Omit for automatic cadence: 30s, 1m, 2m, 4m, 8m, 15m, then every 30m.'
      ),
  },
  async execute(args, ctx) {
    await checkCommandPermission(args.command, args.args ?? [])

    if (args.workdir) {
      await checkWorkdirPermission(args.workdir)
    }

    const sessionId = ctx.sessionID
    const info = manager.spawn({
      command: args.command,
      args: args.args,
      workdir: args.workdir,
      env: args.env,
      title: args.title,
      description: args.description,
      parentSessionId: sessionId,
      parentAgent: ctx.agent,
      notifyOnExit: args.notifyOnExit,
      timeoutSeconds: args.timeoutSeconds,
      nudgeIntervalSeconds: args.nudgeIntervalSeconds,
    })

    const output = [
      `<pty_spawned>`,
      `ID: ${info.id}`,
      `Title: ${info.title}`,
      `Command: ${info.command} ${info.args.join(' ')}`,
      `Workdir: ${info.workdir}`,
      `PID: ${info.pid}`,
      `Status: ${info.status}`,
      `NotifyOnExit: ${info.notifyOnExit}`,
      `TimeoutSeconds: ${info.timeoutSeconds ?? 'none'}`,
      formatNudgeSummary(info),
      `</pty_spawned>`,
      ...(info.notifyOnExit ? ['', NOTIFY_ON_EXIT_INSTRUCTIONS] : []),
      ...(info.nudgeEnabled ? ['', NUDGE_INSTRUCTIONS] : []),
    ].join('\n')

    return output
  },
})
