import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it } from 'vitest'
import { extractSummary, SUMMARY_LIMIT } from '../src/core/result-summary.ts'
import { HostExecutionRunner } from '../src/host-runner.ts'

function ok<T>(request: { rpcId: unknown }, value: T) {
  return { rpcId: request.rpcId, result: { ok: true as const, value } }
}

function assistantEvent(seq: number, time: number, text: string) {
  return { event: { type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } } }
}

describe('extractSummary', () => {
  it('returns undefined without a text-bearing assistant message', () => {
    expect(extractSummary([])).toBeUndefined()
    expect(extractSummary([{ event: { type: 'turn/end', data: {} } }])).toBeUndefined()
    expect(extractSummary([{ event: { type: 'assistant/message', data: {} } }])).toBeUndefined()
  })

  it('extracts the newest assistant message by seq', () => {
    const events = [assistantEvent(2, 2, 'first'), assistantEvent(5, 5, 'final answer')]
    expect(extractSummary(events)).toBe('final answer')
  })

  it('drops events that predate the execution window', () => {
    expect(extractSummary([assistantEvent(5, 5, 'old')], 10)).toBeUndefined()
    expect(extractSummary([assistantEvent(5, 15, 'new')], 10)).toBe('new')
  })

  it('concatenates text blocks and truncates to the summary limit', () => {
    const events = [{ event: { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }] } } } }]
    expect(extractSummary(events)).toBe('hi there')
    expect(extractSummary([assistantEvent(1, 1, 'a'.repeat(SUMMARY_LIMIT + 100))])).toBe('a'.repeat(SUMMARY_LIMIT) + '…')
  })

  it('tolerates unknown content shapes and falls through to the real text', () => {
    const events = [
      { event: { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'image', url: 'x' }] } } } },
      { event: { type: 'assistant/message', seq: 2, time: 2, data: 'not-an-object' } },
      assistantEvent(3, 3, 'real'),
    ]
    expect(extractSummary(events)).toBe('real')
  })
})

describe('HostExecutionRunner result summary', () => {
  it('returns the final assistant text on a completed turn', async () => {
    const api = {
      sessions: {
        list: async (request: { rpcId: unknown }) => ok(request, { items: [{ sessionId: 'session-a', running: false }] }),
        history: async (request: { rpcId: unknown }) => ok(request, {
          events: [
            { event: { type: 'turn/end', seq: 20, time: 2_000, data: { reason: { kind: 'complete' } } } },
            assistantEvent(15, 1_500, 'the fix is applied'),
          ],
          hasMore: false,
        }),
      },
    }
    await expect(new HostExecutionRunner(api as unknown as ApiProxy).inspect('session-a', 1_000))
      .resolves.toEqual({ outcome: 'succeeded', summary: 'the fix is applied' })
  })

  it('omits the summary when the turn produced no assistant text', async () => {
    const api = {
      sessions: {
        list: async (request: { rpcId: unknown }) => ok(request, { items: [{ sessionId: 'session-a', running: false }] }),
        history: async (request: { rpcId: unknown }) => ok(request, {
          events: [{ event: { type: 'turn/end', seq: 10, time: 1_100, data: { reason: { kind: 'complete' } } } }],
          hasMore: false,
        }),
      },
    }
    await expect(new HostExecutionRunner(api as unknown as ApiProxy).inspect('session-a', 1_000))
      .resolves.toEqual({ outcome: 'succeeded' })
  })
})
