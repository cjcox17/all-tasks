// @vitest-environment jsdom
/**
 * Session-view timestamps: clock/duration formatters, the tool-chip injection
 * into settled assistant steps, and the message-clock stylesheet toggle.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import {
  findToolBlock,
  formatSessionClock,
  formatSessionDuration,
  hideMessageClocks,
  injectToolTimeChips,
  makeAssistantTimeShadow,
  showMessageClocks,
  toolCallDurationMs,
  toolCallStartTime,
  type AssistantTimeOwner,
  type ToolNodeStoreLike,
} from '../src/client/session-times.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function nodeStore(blocks: readonly ToolCallBlock[]): ToolNodeStoreLike {
  const nodes = new Map(blocks.map(block => [`1:tool-call${block.callId}`, { kind: 'tool-call', data: { root: block } }]))
  return { values: () => [...nodes.values()] }
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

  it('injects tool chips for a settled step and renders the official message', () => {
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3))])
    const snapshot = { chat: { nodes } }
    const row = toolRowInDocument('c1')
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(<Shadow node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'settled' } }} useSession={(selector) => selector(snapshot)} />)
    expect(document.querySelector('[data-official="assistant"]')?.textContent).toBe('7:assistant-step')
    expect(row.querySelector('[data-dsh-part="session-time"]')?.textContent).toBe('09:00:00 · 3.0s')
  })

  it('skips injection while a step is still running', () => {
    const nodes = nodeStore([settledTool('c1', todayAt(9, 0, 0), todayAt(9, 0, 3))])
    const snapshot = { chat: { nodes } }
    const row = toolRowInDocument('c1')
    const Shadow = makeAssistantTimeShadow(officialStub, () => true)
    render(<Shadow node={{ key: '7:assistant-step', kind: 'assistant-step', data: { status: 'running' } }} useSession={(selector) => selector(snapshot)} />)
    expect(row.querySelectorAll('[data-dsh-part="session-time"]').length).toBe(0)
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
