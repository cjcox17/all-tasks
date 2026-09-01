/**
 * Execution token accounting: aggregate the adapter's per-step usage into one
 * run total, ignoring non-assistant events and events before the run start.
 */
import { describe, expect, it } from 'vitest'
import { extractUsage, type UsageEvent } from '../src/core/execution-usage.ts'

function message(overrides: Record<string, unknown> = {}): UsageEvent {
  return {
    event: {
      type: 'assistant/message',
      seq: 1,
      time: 1000,
      data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 5 }, ...overrides },
    },
  }
}

describe('extractUsage', () => {
  it('sums input/output across every assistant/message event', () => {
    const events = [
      message({ usage: { inputTokens: 10, outputTokens: 5 } }),
      message({ usage: { inputTokens: 30, outputTokens: 20, cacheReadTokens: 4, reasoningTokens: 9 } }),
    ]
    expect(extractUsage(events)).toEqual({ inputTokens: 40, outputTokens: 25, cacheReadTokens: 4, reasoningTokens: 9 })
  })

  it('ignores non-assistant events and events before the run start', () => {
    const events = [
      { event: { type: 'turn/end', time: 2000, data: {} } },
      message({ usage: { inputTokens: 100, outputTokens: 1 } }),
      { event: { type: 'assistant/message', time: 500, data: { usage: { inputTokens: 999, outputTokens: 1 } } } },
    ]
    expect(extractUsage(events, 1000)).toEqual({ inputTokens: 100, outputTokens: 1 })
  })

  it('returns undefined when no event reported usage', () => {
    expect(extractUsage([{ event: { type: 'assistant/message', time: 1000, data: {} } }])).toBeUndefined()
    expect(extractUsage([])).toBeUndefined()
  })

  it('skips malformed usage blocks instead of failing', () => {
    const events = [
      { event: { type: 'assistant/message', time: 1000, data: { usage: { inputTokens: 'x', outputTokens: 1 } } } },
      message({ usage: { inputTokens: 7, outputTokens: 2 } }),
    ]
    expect(extractUsage(events)).toEqual({ inputTokens: 7, outputTokens: 2 })
  })
})
