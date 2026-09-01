/**
 * Result capture: a bounded, defensive excerpt of an agent execution's final
 * answer, derived from the raw session history events the runner already scans
 * to detect settlement. Pure and framework-free so it is unit-testable in
 * isolation, exactly like the cron and task transitions in this directory.
 */

/** Maximum characters of agent text retained per execution. */
export const SUMMARY_LIMIT = 2000

/** Structural view of one history entry; tolerant of unknown/future shapes. */
export interface SummaryEvent {
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: unknown
  }
}

/** Concatenated text of an `assistant/message` event's message content, if any. */
function messageText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as Record<string, unknown>
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text !== '') {
      parts.push(candidate.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * The newest text-bearing `assistant/message` within the given events, bounded
 * to {@link SUMMARY_LIMIT}. Events may be in any order; the highest seq (then
 * time) wins. `since` drops events that predate the execution (a fresh session
 * has none, but a shared session could page into an earlier turn).
 */
export function extractSummary(events: readonly SummaryEvent[], since = 0): string | undefined {
  let best: { key: number; text: string } | undefined
  for (const entry of events) {
    const event = entry?.event
    if (event === undefined || event.type !== 'assistant/message') continue
    const time = typeof event.time === 'number' ? event.time : undefined
    if (since > 0 && time !== undefined && time < since) continue
    const text = messageText(event.data)
    if (text === undefined) continue
    const key = typeof event.seq === 'number' ? event.seq : time ?? 0
    if (best === undefined || key > best.key) best = { key, text }
  }
  if (best === undefined) return undefined
  return best.text.length > SUMMARY_LIMIT ? `${best.text.slice(0, SUMMARY_LIMIT)}…` : best.text
}
