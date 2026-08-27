import type { PTYSessionInfo } from './types.ts'

export function formatSessionInfo(session: PTYSessionInfo): string[] {
  const timedOutInfo = session.timedOut ? ' | timed out' : ''
  const exitInfo = session.exitCode !== undefined ? ` | exit: ${session.exitCode}` : ''
  const exitSignal = session.exitSignal ? ` | signal: ${session.exitSignal}` : ''
  const timeoutInfo =
    session.timeoutSeconds !== undefined ? ` | timeout: ${session.timeoutSeconds}s` : ''
  return [
    `[${session.id}] ${session.title}`,
    `  Command: ${session.command} ${session.args.join(' ')}`,
    `  Status: ${session.status}${timedOutInfo}${exitInfo}${exitSignal}`,
    `  PID: ${session.pid}${timeoutInfo}`,
    `  Lines: ${session.lineCount}`,
    `  ${formatNudgeSummary(session)}`,
    `  Workdir: ${session.workdir}`,
    `  Created: ${session.createdAt}`,
    '',
  ]
}

export function formatNudgeSummary(session: PTYSessionInfo, now: number = Date.now()): string {
  if (!session.nudgeEnabled) {
    return 'Nudges: disabled'
  }

  const base =
    session.nudgePolicy === 'recurring'
      ? `recurring every ${session.nudgeIntervalSeconds ?? 'unknown'}s`
      : `automatic step ${(session.nudgeAutomaticStep ?? 0) + 1}`
  const state = session.nudgePaused ? `paused, preserving ${base}` : base
  const oneShot =
    session.nudgeOneShotDelaySeconds === undefined
      ? ''
      : ` | one-shot: ${session.nudgeOneShotDelaySeconds}s`
  let next = 'none'
  if (session.nudgeNextDueAt) {
    const dueAt = new Date(session.nudgeNextDueAt).getTime()
    const remainingSeconds = Math.ceil((dueAt - now) / 1000)
    next =
      remainingSeconds > 0 ? `${session.nudgeNextDueAt} (in ${remainingSeconds}s)` : 'due, waiting'
  }
  return `Nudges: ${state}${oneShot} | next: ${next}`
}

export function formatLine(line: string, lineNum: number, maxLength: number = 2000): string {
  const lineNumStr = lineNum.toString().padStart(5, '0')
  const truncatedLine = line.length > maxLength ? `${line.slice(0, maxLength)}...` : line
  return `${lineNumStr}| ${truncatedLine}`
}
