/**
 * Open-question watcher tests: the mux-stream subscription that tracks which
 * execution session is waiting on the human's answer to an ask_user_question.
 */
import type { MuxFrame, RpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenQuestionWatcher } from '../src/host-questions.ts'

/** Test payloads use plain strings where the wire types brand ids. */
type TestQuestionItem = { id: string; question: string; header?: string }
type TestQuestionFrame =
  | { type: 'question/requested'; sessionId: string; questions: TestQuestionItem[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }

function frame(payload: TestQuestionFrame, rpcId = 'q-1'): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as RpcId, payload: payload as unknown as MuxFrame }
}

/** A mux fake the test can push frames into; the stream never ends. */
function muxFake() {
  const queue: RpcRequest<MuxFrame>[] = []
  const waits: Array<() => void> = []
  const mux = vi.fn(() => (async function* () {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!
      await new Promise<void>(resolve => { waits.push(resolve) })
    }
  })())
  const events = { mux }
  const push = (value: RpcRequest<MuxFrame>): void => {
    queue.push(value)
    waits.shift()?.()
  }
  return { events, mux, push }
}

/** Flush microtasks so the watcher's consume loop has processed pushed frames. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

const warn = (): void => {}

describe('OpenQuestionWatcher', () => {
  const watchers: OpenQuestionWatcher[] = []

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop()
  })

  function make(events: { mux?: unknown }, now: () => number = () => 1_000): OpenQuestionWatcher {
    const watcher = new OpenQuestionWatcher({ events } as never, { now, warn })
    watchers.push(watcher)
    return watcher
  }

  it('records an open question from question/requested and clears it on question/resolved', async () => {
    const fake = muxFake()
    const watcher = make(fake.events)
    watcher.start()
    await settle()
    fake.push(frame({
      type: 'question/requested',
      sessionId: 's-1',
      questions: [{ id: 'a', question: 'Proceed with the plan?', header: 'Plan' }],
    }, 'q-1'))
    await settle()
    expect(watcher.get('s-1')).toEqual({ askedAt: 1_000, count: 1, summary: 'Proceed with the plan?' })

    // A resolution for a different rpcId must not clear this ask.
    fake.push(frame({ type: 'question/resolved', sessionId: 's-1', questionRpcId: 'q-other', outcome: 'answered' }))
    await settle()
    expect(watcher.get('s-1')).toEqual({ askedAt: 1_000, count: 1, summary: 'Proceed with the plan?' })

    // The matching resolution clears it (answered or cancelled alike).
    fake.push(frame({ type: 'question/resolved', sessionId: 's-1', questionRpcId: 'q-1', outcome: 'answered' }))
    await settle()
    expect(watcher.get('s-1')).toBeUndefined()
  })

  it('ignores empty question batches and non-question frames', async () => {
    const fake = muxFake()
    const watcher = make(fake.events)
    watcher.start()
    await settle()

    fake.push(frame({ type: 'question/requested', sessionId: 's-1', questions: [] }, 'q-1'))
    fake.push({ rpcId: 'q-9' as RpcId, payload: { type: 'session/event', sessionId: 's-1', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } } as unknown as MuxFrame })
    await settle()
    expect(watcher.get('s-1')).toBeUndefined()
  })

  it('summarizes a multi-question batch from its first question', async () => {
    const fake = muxFake()
    const watcher = make(fake.events)
    watcher.start()
    await settle()

    fake.push(frame({
      type: 'question/requested',
      sessionId: 's-1',
      questions: [{ id: 'a', question: 'First' }, { id: 'b', question: 'Second' }],
    }, 'q-1'))
    await settle()
    expect(watcher.get('s-1')).toEqual({ askedAt: 1_000, count: 2, summary: 'First' })
  })

  it('notifies subscribers only when the open set actually changes', async () => {
    const fake = muxFake()
    const watcher = make(fake.events)
    const onChange = vi.fn()
    watcher.onChange(onChange)
    watcher.start()
    await settle()

    fake.push(frame({ type: 'question/requested', sessionId: 's-1', questions: [{ id: 'a', question: 'Go?' }] }, 'q-1'))
    await settle()
    expect(onChange).toHaveBeenCalledTimes(1)

    // A duplicate replay of the same ask (mux reopen baseline) is a no-op.
    fake.push(frame({ type: 'question/requested', sessionId: 's-1', questions: [{ id: 'a', question: 'Go?' }] }, 'q-1'))
    await settle()
    expect(onChange).toHaveBeenCalledTimes(1)

    fake.push(frame({ type: 'question/resolved', sessionId: 's-1', questionRpcId: 'q-1', outcome: 'cancelled' }))
    await settle()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('prunes entries for sessions that are no longer relevant', async () => {
    const fake = muxFake()
    const watcher = make(fake.events)
    watcher.start()
    await settle()

    fake.push(frame({ type: 'question/requested', sessionId: 's-1', questions: [{ id: 'a', question: 'A?' }] }, 'q-1'))
    fake.push(frame({ type: 'question/requested', sessionId: 's-2', questions: [{ id: 'b', question: 'B?' }] }, 'q-2'))
    await settle()
    expect(watcher.prune(new Set(['s-1']))).toBe(true)
    expect(watcher.get('s-1')).toBeDefined()
    expect(watcher.get('s-2')).toBeUndefined()
    expect(watcher.prune(new Set(['s-1']))).toBe(false)
  })

  it('fails soft when no events gateway exists and when the stream errors, then retries', async () => {
    const warn = vi.fn()
    const noGateway = new OpenQuestionWatcher({} as never, { warn })
    watchers.push(noGateway)
    noGateway.start()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(noGateway.get('s-1')).toBeUndefined()

    // A stream that throws at open: warn + a bounded retry (advance 5 s).
    vi.useFakeTimers()
    try {
      const failing = vi.fn(() => (async function* () {
        throw new Error('stream down')
      })())
      const watcher = new OpenQuestionWatcher({ events: { mux: failing } } as never, { warn })
      watchers.push(watcher)
      watcher.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(failing).toHaveBeenCalledTimes(1)
      // The stream failure warn plus the scheduled-retry warn.
      expect(warn).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failing).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
