import type { IPty } from 'bun-pty'
import type { RingBuffer } from './buffer.ts'

export type PTYStatus = 'running' | 'exited' | 'killing' | 'killed'
export type NudgePolicy = 'automatic' | 'recurring'
export type NudgeSource = NudgePolicy | 'one-shot'
export type NudgeAction = 'next' | 'every' | 'pause' | 'resume' | 'automatic'

export interface PTYSession {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  env?: Record<string, string>
  status: PTYStatus
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: Date
  lastOutputAt?: number
  parentSessionId: string
  parentAgent?: string
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  nudgeEnabled: boolean
  nudgePolicy: NudgePolicy
  nudgePaused: boolean
  nudgeAutomaticStep: number
  nudgeIntervalSeconds?: number
  nudgeOneShotDelaySeconds?: number
  nudgeNextDueAt?: number
  nudgeLastOutputPosition: number
  nudgeGeneration: number
  buffer: RingBuffer
  process: IPty | null
}

export interface PTYSessionInfo {
  id: string
  title: string
  description?: string
  command: string
  args: string[]
  workdir: string
  status: PTYStatus
  notifyOnExit: boolean
  timeoutSeconds?: number
  timedOut: boolean
  nudgeEnabled?: boolean
  nudgePolicy?: NudgePolicy
  nudgePaused?: boolean
  nudgeAutomaticStep?: number
  nudgeIntervalSeconds?: number
  nudgeOneShotDelaySeconds?: number
  nudgeNextDueAt?: string
  exitCode?: number
  exitSignal?: number | string
  pid: number
  createdAt: string
  lastOutputAt?: string
  lineCount: number
}

export interface SpawnOptions {
  command: string
  args?: string[]
  workdir?: string
  env?: Record<string, string>
  title?: string
  description?: string
  parentSessionId: string
  parentAgent?: string
  notifyOnExit?: boolean
  timeoutSeconds?: number
  nudgeIntervalSeconds?: number
  enableNudges?: boolean
}

export interface ReadResult {
  lines: string[]
  totalLines: number
  offset: number
  hasMore: boolean
}

export interface SearchResult {
  matches: Array<{ lineNumber: number; text: string }>
  totalMatches: number
  totalLines: number
  offset: number
  hasMore: boolean
}
