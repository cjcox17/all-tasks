/**
 * Execution token accounting: aggregate the token usage the adapter reports on
 * each `assistant/message` event of a run into one bounded total. A run spans
 * one or more steps (model calls); each step's assembled message carries its
 * own `usage`, so the run total is the sum. Pure and framework-free so it is
 * unit-testable in isolation, mirroring the result-summary capture.
 */
import type { ExecutionUsage } from './tasks.ts'

/** Structural view of one history entry; tolerant of unknown/future shapes. */
export interface UsageEvent {
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: unknown
  }
}

/** The token-usage block one `assistant/message` event may carry. */
function usageOf(data: unknown): ExecutionUsage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const usage = (data as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const inputTokens = count(record.inputTokens)
  const outputTokens = count(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const result: ExecutionUsage = { inputTokens, outputTokens }
  const cacheReadTokens = count(record.cacheReadTokens)
  const cacheWriteTokens = count(record.cacheWriteTokens)
  const reasoningTokens = count(record.reasoningTokens)
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens
  return result
}

/**
 * Sum the `assistant/message` usage across the given events. `since` drops
 * events that predate the execution (a shared session can page into an
 * earlier turn). Returns undefined when no event reported usage — the adapter
 * disclosed none, rather than a zero total.
 */
export function extractUsage(events: readonly UsageEvent[], since = 0): ExecutionUsage | undefined {
  const total: ExecutionUsage = { inputTokens: 0, outputTokens: 0 }
  let saw = false
  for (const entry of events) {
    const event = entry?.event
    if (event === undefined || event.type !== 'assistant/message') continue
    const time = typeof event.time === 'number' ? event.time : undefined
    if (since > 0 && time !== undefined && time < since) continue
    const usage = usageOf(event.data)
    if (usage === undefined) continue
    saw = true
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens
    if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    if (usage.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
  }
  return saw ? total : undefined
}
