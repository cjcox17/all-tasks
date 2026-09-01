// @vitest-environment jsdom
/**
 * Session-view timestamps: clock/duration formatters, the tool-chip injection
 * into settled assistant steps, and the message-clock stylesheet toggle.
 */
import { act, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import {
  billedInputTokens,
  findToolBlock,
  formatSessionClock,
  formatSessionDuration,
  formatTokens,
  hideMessageClocks,
  injectToolTimeChips,
  injectTurnTokenChip,
  makeAssistantTimeShadow,
  showMessageClocks,
  toolCallDurationMs,
  toolCallStartTime,
  turnTailUsage,
  type AssistantTimeOwner,
  type TokenUsageLike,
  type ToolNodeStoreLike,
  type ToolTimeNodeLike,
} from '../src/client/session-times.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The all-tasks dictionary selects by document language; pin English so chip
// copy is deterministic in jsdom.
document.documentElement.lang = 'en'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  hideMessageClocks()
})

function render(component: ReactElement): void {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  roots.push(root)
  act(() => { root.render(component) })
}

/** A settled tool result with its call head still in-window. */
function settledTool(callId: string, startMs: number, endMs: number): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 3,
    time: endMs,
    callId,
    call: { name: 'bash', argsRaw: 'pwd' },
    callTime: startMs,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

/** A tool call still running (no result yet). */
function runningTool(callId: string, startMs: number): ToolCallBlock {
  return {
    callId,
    name: 'bash',
    argsRaw: 'pwd',
    turn: 1,
    step: 2,
    time: startMs,
    callView: null,
    subCalls: [],
  }
}

function nodeStore(entries: readonly (ToolCallBlock | ToolTimeNodeLike)[]): ToolNodeStoreLike {
  const values: ToolTimeNodeLike[] = entries.map((entry) => {
    const block = entry as ToolCallBlock
    if (('callId' in block) && (!('kind' in block) || block.kind === 'tool-result')) {
      return { kind: 'tool-call', data: { root: block } }
    }
    return entry as ToolTimeNodeLike
  })
  return { values: () => values }
}

/** A timestamp at the given wall-clock time on the current day (same-day clock). */
function todayAt(hours: number, minutes: number, seconds: number): number {
  const d = new Date()
  d.setHours(hours, minutes, seconds, 0)
  return d.getTime()
}

describe('formatSessionClock', () => {
  const NOW = new Date(2026, 0, 15, 12, 30, 0).getTime()

  it('formats the same calendar day as HH:MM:SS', () => {
    expect(formatSessionClock(new Date(2026, 0, 15, 9, 5, 7).getTime(), NOW)).toBe('09:05:07')
  })

  it('formats an earlier day this year as M/D HH:MM:SS', () => {
    expect(formatSessionClock(new Date(2026, 0, 3, 23, 59, 59).getTime(), NOW)).toBe('1/3 23:59:59')
  })

  it('formats another year as Y/M/D HH:MM:SS', () => {
    expect(formatSessionClock(new Date(2025, 11, 31, 8, 0, 1).getTime(), NOW)).toBe('2025/12/31 08:00:01')
  })

  it('zero-pads every field', () => {
    expect(formatSessionClock(new Date(2026, 0, 15, 1, 2, 3).getTime(), NOW)).toBe('01:02:03')
  })
})

describe('formatSessionDuration', () => {
  it('formats sub-minute runs with one decimal', () => {
    expect(formatSessionDuration(3200)).toBe('3.2s')
    expect(formatSessionDuration(0)).toBe('0.0s')
  })

  it('formats minute runs as Mm SSs', () => {
    expect(formatSessionDuration(65_000)).toBe('1m 05s')
    expect(formatSessionDuration(2 * 60_000 + 30_000)).toBe('2m 30s')
  })

  it('formats hour runs as Hh MMm SSs', () => {
    expect(formatSessionDuration(3 * 3_600_000 + 2 * 60_000 + 5_000)).toBe('3h 02m 05s')
  })

  it('returns empty for invalid inputs', () => {
    expect(formatSessionDuration(Number.NaN)).toBe('')
    expect(formatSessionDuration(-5)).toBe('')
  })
})

describe('tool call time reads', () => {
  it('reads the call start from a running tool', () => {
    const tool = runningTool('c1', 1000)
    expect(toolCallStartTime(tool)).toBe(1000)
    expect(toolCallDurationMs(tool)).toBeUndefined()
  })

  it('reads the call start and duration from a settled tool with the call in-window', () => {
    const tool = settledTool('c1', 1000, 4500)
    expect(toolCallStartTime(tool)).toBe(1000)
    expect(toolCallDurationMs(tool)).toBe(3500)
  })

  it('falls back to the result time when the call head is out of-window', () => {
    const tool: ToolCallBlock = {
      ...settledTool('c1', 0, 4500),
      call: null,
      callTime: null,
    }
    expect(toolCallStartTime(tool)).toBe(4500)
    expect(toolCallDurationMs(tool)).toBeUndefined()
  })

  it('handles an undefined root', () => {
    expect(toolCallStartTime(undefined)).toBeUndefined()
    expect(toolCallDurationMs(undefined)).toBeUndefined()
  })
})

describe('findToolBlock', () => {
  it('finds a tool-call node by call id', () => {
    const nodes = nodeStore([settledTool('c1', 1000, 2000), runningTool('c2', 500)])
    expect(findToolBlock(nodes, 'c2')?.callId).toBe('c2')
    expect(findToolBlock(nodes, 'missing')).toBeUndefined()
    expect(findToolBlock(undefined, 'c1')).toBeUndefined()
  })
})

describe('token helpers', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1K')
    expect(formatTokens(15_400)).toBe('15.4K')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('bills input as fresh input plus cache reads and writes', () => {
    expect(billedInputTokens(undefined)).toBe(0)
    expect(billedInputTokens({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 })).toBe(1000)
    expect(billedInputTokens({ inputTokens: 100, cacheWriteTokens: 300 })).toBe(400)
  })

  it('reads the closing usage of a turn from the node store', () => {
    const nodes: ToolNodeStoreLike = {
      values: () => [
        { kind: 'tool-call', data: { root: settledTool('c1', 0, 1) } },
        { kind: 'turn-tail', data: { turn: 3, closing: { usage: { inputTokens: 100, outputTokens: 25 } } } },
      ],
    }
    expect(turnTailUsage(nodes, 3)).toEqual({ inputTokens: 100, outputTokens: 25 })
    expect(turnTailUsage(nodes, 7)).toBeUndefined()
    expect(turnTailUsage(undefined, 3)).toBeUndefined()
  })
})

describe('injectTurnTokenChip', () => {
  const USAGE: TokenUsageLike = { inputTokens: 100, outputTokens: 25, cacheReadTokens: 900 }

  function turnTailInDocument(turn: number): HTMLElement {
    const tail = document.createElement('div')
    tail.setAttribute('data-turn-tail', String(turn))
    const actions = document.createElement('div')
    actions.setAttribute('data-dsh-part', 'tail-actions')
    actions.textContent = '22:59 · 174 tok/s'
    tail.appendChild(actions)
    document.body.appendChild(tail)
    return tail
  }

  it('appends an input/output token chip to the turn tail actions row', () => {
    const tail = turnTailInDocument(3)
    expect(injectTurnTokenChip(document.body, 3, USAGE)).toBe(true)
    const chip = tail.querySelector('[data-dsh-part="session-tokens"]')
    expect(chip?.textContent).toBe('Input 1K tok · Output 25 tok')
    expect(chip?.parentElement?.getAttribute('data-dsh-part')).toBe('tail-actions')
  })

  it('is idempotent and skips turns without usage', () => {
    const tail = turnTailInDocument(3)
    injectTurnTokenChip(document.body, 3, USAGE)
    expect(injectTurnTokenChip(document.body, 3, USAGE)).toBe(false)
    expect(tail.querySelectorAll('[data-dsh-part="session-tokens"]').length).toBe(1)
    expect(injectTurnTokenChip(document.body, 9, USAGE)).toBe(false)
    expect(injectTurnTokenChip(document.body, 3, undefined)).toBe(false)
  })

  it('skips a zero-usage turn', () => {
    turnTailInDocument(5)
    expect(injectTurnTokenChip(document.body, 5, {})).toBe(false)
  })
})

describe('injectToolTimeChips', () => {
  it('prepends a start-time and duration chip to each tool row', () => {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow-key', '1:assistant-step')
    flow.innerHTML = [
      '<div data-chat-call-id="c1"><div data-disclosure-row="true">Bash</div></div>',
      '<div data-chat-call-id="c2"><div data-disclosure-row="true">Read</div></div>',
    ].join('')
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3)), settledTool('c2', todayAt(9, 0, 5), todayAt(9, 0, 6))])
    const injected = injectToolTimeChips(flow, nodes)
    expect(injected).toBe(2)
    const chips = [...flow.querySelectorAll('[data-dsh-part="session-time"]')]
    expect(chips.map(chip => chip.textContent)).toEqual(['09:00:00 · 3.0s', '09:00:05 · 1.0s'])
    expect(chips[0]?.parentElement?.getAttribute('data-disclosure-row')).toBe('true')
  })

  it('omits rows whose call is out of window', () => {
    const flow = document.createElement('div')
    flow.innerHTML = '<div data-chat-call-id="gone"><div data-disclosure-row="true">Bash</div></div>'
    expect(injectToolTimeChips(flow, nodeStore([]))).toBe(0)
    expect(flow.querySelectorAll('[data-dsh-part="session-time"]').length).toBe(0)
  })

  it('is idempotent across repeated calls', () => {
    const flow = document.createElement('div')
    flow.innerHTML = '<div data-chat-call-id="c1"><div data-disclosure-row="true">Bash</div></div>'
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3))])
    injectToolTimeChips(flow, nodes)
    injectToolTimeChips(flow, nodes)
    expect(flow.querySelectorAll('[data-dsh-part="session-time"]').length).toBe(1)
  })
})

describe('makeAssistantTimeShadow', () => {
  function officialStub(props: AssistantTimeOwner): ReactElement {
    return <div data-official="assistant">{String(props.node?.key ?? 'none')}</div>
  }

  /** A tool row in the document (as the flow renders one per tool call). */
  function toolRowInDocument(callId: string): HTMLElement {
    const row = document.createElement('div')
    row.setAttribute('data-chat-call-id', callId)
    const title = document.createElement('div')
    title.setAttribute('data-disclosure-row', 'true')
    title.textContent = 'Bash'
    row.appendChild(title)
    document.body.appendChild(row)
    return row
  }

  it('injects tool chips and a turn token chip for a settled step and renders the official message', () => {
    const nodes = nodeStore([
      settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3)),
      { kind: 'turn-tail', data: { turn: 7, closing: { usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 900 } } } } as unknown as ToolTimeNodeLike,
    ])
    const snapshot = { chat: { nodes } }
    const row = toolRowInDocument('c1')
    const tail = document.createElement('div')
    tail.setAttribute('data-turn-tail', '7')
    const actions = document.createElement('div')
    actions.setAttribute('data-dsh-part', 'tail-actions')
    tail.appendChild(actions)
    document.body.appendChild(tail)
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(<Shadow node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'settled', turn: 7 } }} useSession={(selector) => selector(snapshot)} />)
    expect(document.querySelector('[data-official="assistant"]')?.textContent).toBe('7:assistant-step')
    expect(row.querySelector('[data-dsh-part="session-time"]')?.textContent).toBe('09:00:00 · 3.0s')
    const tokenChip = tail.querySelector('[data-dsh-part="session-tokens"]')
    expect(tokenChip?.textContent).toBe('Input 1K tok · Output 25 tok')
  })

  it('skips injection while a step is still running', () => {
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3))])
    const snapshot = { chat: { nodes } }
    const row = toolRowInDocument('c1')
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(<Shadow node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'running', turn: 7 } }} useSession={(selector) => selector(snapshot)} />)
    expect(row.querySelectorAll('[data-dsh-part="session-time"]').length).toBe(0)
    expect(document.querySelectorAll('[data-dsh-part="session-tokens"]').length).toBe(0)
  })

  it('forwards to the official renderer with no injection when disabled', () => {
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3))])
    const snapshot = { chat: { nodes } }
    const row = toolRowInDocument('c1')
    const Shadow = makeAssistantTimeShadow(officialStub, () => false)
    render(<Shadow node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'settled' } }} useSession={(selector) => selector(snapshot)} />)
    expect(document.querySelector('[data-official="assistant"]')).not.toBeNull()
    expect(row.querySelectorAll('[data-dsh-part="session-time"]').length).toBe(0)
  })
})

describe('makeAssistantTimeShadow turn-tail arrival timing', () => {
  function officialStub(props: AssistantTimeOwner): ReactElement {
    return <div data-official="assistant">{String(props.node?.key ?? 'none')}</div>
  }

  /**
   * Mutable node store keeping ONE instance while its values change — the real
   * `MutableChatNodeStore` behavior, which makes `snapshot.chat.nodes`
   * referentially stable across node updates.
   */
  class MutableStore implements ToolNodeStoreLike {
    private entries: ToolTimeNodeLike[] = []
    private cache: readonly ToolTimeNodeLike[] = []
    private dirty = true

    upsert(...nodes: ToolTimeNodeLike[]): void {
      this.entries = [...this.entries, ...nodes]
      this.dirty = true
    }

    values(): readonly ToolTimeNodeLike[] {
      if (this.dirty) {
        this.cache = this.entries
        this.dirty = false
      }
      return this.cache
    }
  }

  /**
   * Subscribable conversation snapshot whose `chat.nodes` reference is stable
   * across updates while `chat.order` is replaced on structural changes —
   * matching the real snapshot builder. The shadow's `useSession` is backed by
   * `useSyncExternalStore`, so the shadow re-renders only when a selected
   * value changes identity (exactly like the real session-standard-kit hook).
   */
  function conversationStore(nodes: MutableStore) {
    let snapshot: { chat: { nodes: MutableStore; order: readonly string[] } } = {
      chat: { nodes, order: [] },
    }
    const listeners = new Set<() => void>()
    return {
      get: () => snapshot,
      update: (patch: { order: readonly string[] }): void => {
        snapshot = { chat: { nodes, order: patch.order } }
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
  }

  function useSessionFrom(store: ReturnType<typeof conversationStore>) {
    return function useSession<T>(selector: (snapshot: unknown) => T): T {
      return useSyncExternalStore(store.subscribe, () => selector(store.get()))
    }
  }

  it('injects the token chip when the turn tail appears after this step settled', () => {
    // A tool row for this step already exists when the step settles (tool
    // calls precede the closing message), so the tool time chip injects.
    const row = document.createElement('div')
    row.setAttribute('data-chat-call-id', 'c1')
    const title = document.createElement('div')
    title.setAttribute('data-disclosure-row', 'true')
    title.textContent = 'Bash'
    row.appendChild(title)
    document.body.appendChild(row)

    const nodes = new MutableStore()
    nodes.upsert({ kind: 'tool-call', data: { root: settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3)) } } as unknown as ToolTimeNodeLike)
    const store = conversationStore(nodes)
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(
      <Shadow
        node={{
          key: '7:assistant-step',
          kind: 'assistant-step',
          data: { status: 'settled', turn: 7, usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 900 } },
        }}
        useSession={useSessionFrom(store)}
      />,
    )
    // Settle-time commit: the closing usage exists but the turn-tail row does
    // not (it appears only at turn/end), so no token chip yet — the tool time
    // chip does inject.
    expect(row.querySelector('[data-dsh-part="session-time"]')?.textContent).toBe('09:00:00 · 3.0s')
    expect(document.querySelectorAll('[data-dsh-part="session-tokens"]').length).toBe(0)

    // turn/end: the flow adds the turn-tail node (same chat.nodes instance) and
    // the tail row lands in the DOM. The assistant-step seat does not re-render
    // (its node prop reference is unchanged), so only the shadow's own
    // subscriptions can re-run the injection effect.
    nodes.upsert({
      kind: 'turn-tail',
      data: { turn: 7, closing: { usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 900 } } },
    } as unknown as ToolTimeNodeLike)
    const tail = document.createElement('div')
    tail.setAttribute('data-turn-tail', '7')
    const actions = document.createElement('div')
    actions.setAttribute('data-dsh-part', 'tail-actions')
    tail.appendChild(actions)
    document.body.appendChild(tail)
    act(() => { store.update({ order: ['tool-call', 'assistant-step', 'turn-tail'] }) })

    const chip = tail.querySelector('[data-dsh-part="session-tokens"]')
    expect(chip?.textContent).toBe('Input 1K tok · Output 25 tok')
  })

  it('does not inject a token chip when the turn tail never gains usage', () => {
    const nodes = new MutableStore()
    const store = conversationStore(nodes)
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(
      <Shadow
        node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'settled', turn: 7 } }}
        useSession={useSessionFrom(store)}
      />,
    )
    const tail = document.createElement('div')
    tail.setAttribute('data-turn-tail', '7')
    const actions = document.createElement('div')
    actions.setAttribute('data-dsh-part', 'tail-actions')
    tail.appendChild(actions)
    document.body.appendChild(tail)
    nodes.upsert({ kind: 'turn-tail', data: { turn: 7, closing: {} } } as unknown as ToolTimeNodeLike)
    act(() => { store.update({ order: ['turn-tail'] }) })
    expect(document.querySelectorAll('[data-dsh-part="session-tokens"]').length).toBe(0)
  })
})

describe('message-clock stylesheet toggle', () => {
  it('injects the override once and removes it on hide', () => {
    showMessageClocks()
    showMessageClocks()
    const tags = document.querySelectorAll('style[data-dsh-session-time-override]')
    expect(tags.length).toBe(1)
    expect(tags[0]?.textContent).toContain('[data-time-hover-root]')
    hideMessageClocks()
    expect(document.querySelectorAll('style[data-dsh-session-time-override]').length).toBe(0)
  })
})
