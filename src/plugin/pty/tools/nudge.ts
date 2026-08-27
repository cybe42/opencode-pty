import { tool } from '@opencode-ai/plugin'
import { formatNudgeSummary } from '../formatters.ts'
import { manager } from '../manager.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './nudge.txt'

export const ptyNudge = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    action: tool.schema
      .enum(['next', 'every', 'pause', 'resume', 'automatic'])
      .describe('The nudge scheduling action to apply'),
    seconds: tool.schema
      .number()
      .optional()
      .describe('Positive integer delay required by next and every; unused by other actions'),
  },
  async execute(args) {
    const session = manager.configureNudge(args.id, args.action, args.seconds)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    return [
      '<pty_nudge_config>',
      `ID: ${session.id}`,
      formatNudgeSummary(session),
      '</pty_nudge_config>',
    ].join('\n')
  },
})
