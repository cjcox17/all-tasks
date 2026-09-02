// @vitest-environment jsdom
/**
 * Usage charts component: the cost/tokens graphs on the landing dashboard —
 * section and panel structure, the shared granularity dropdown (which drives
 * the bucket count of both panels), bar data attributes, and the empty states.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageCharts } from '../src/client/board/UsageCharts.tsx'
import { t } from '../src/client/locales.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'T', description: '', prompt: '' }, 0, `t-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  }
}

/** A settled execution with usage, started within the current hour. */
function usedExecution(input: number, output: number, reasoning = 0) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    sessionId: 's',
    startedAt: Date.now() - 5 * 60_000,
    endedAt: Date.now() - 60_000,
    result: 'succeeded' as const,
    error: undefined,
    endpointId: 'lm',
    usage: { inputTokens: input, outputTokens: output, ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}) },
  }
}

/** A local endpoint with USD-per-1M pricing for the cost-bar assertions. */
const LOCAL: Array<{ id: string; provider: string; costPerMillionInputTokens: number; costPerMillionOutputTokens: number }> = [
  { id: 'lm', provider: 'lm-studio', costPerMillionInputTokens: 0.27, costPerMillionOutputTokens: 1.10 },
]

function render(children: React.ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(children) })
  return container
}

function bars(): Element[] {
  return Array.from(document.querySelectorAll('[data-dsh-part="usage-bar"]'))
}

function panel(chart: 'cost' | 'tokens'): HTMLElement {
  return document.querySelector(`[data-dsh-part="usage-chart"][data-chart="${chart}"]`) as HTMLElement
}

describe('UsageCharts', () => {
  it('renders the section, the granularity dropdown, and both panels', () => {
    render(<UsageCharts tasks={[task({ executions: [usedExecution(100, 50)] })]} />)
    expect(document.querySelector('[data-dsh-part="usage"]')).not.toBeNull()
    const select = document.querySelector('[data-dsh-part="usage-granularity"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(Array.from(select.options).map(option => option.value)).toEqual(['hourly', 'daily', 'weekly'])
    expect(select.value).toBe('daily')
    expect(panel('cost')).not.toBeNull()
    expect(panel('tokens')).not.toBeNull()
  })

  it('shows stacked token bars with the aggregated value, and a cost bar per bucket', () => {
    render(<UsageCharts tasks={[task({ executions: [usedExecution(1000, 500, 50)] })]} endpoints={LOCAL} />)
    // Daily window: 14 buckets in each panel.
    expect(panel('tokens').querySelectorAll('[data-dsh-part="usage-bar"]')).toHaveLength(14)
    expect(panel('cost').querySelectorAll('[data-dsh-part="usage-bar"]')).toHaveLength(14)
    // The current-day bucket carries the stacked total (input + output + reasoning).
    const tokenBars = Array.from(panel('tokens').querySelectorAll('[data-dsh-part="usage-bar"]'))
    const today = tokenBars.find(bar => Number(bar.getAttribute('data-value')) > 0)!
    expect(today.getAttribute('data-value')).toBe('1550')
    expect(today.getAttribute('data-start')).not.toBeNull()
    // The cost panel renders its own bars (same buckets, cost values).
    const costBars = Array.from(panel('cost').querySelectorAll('[data-dsh-part="usage-bar"]'))
    const costToday = costBars.find(bar => Number(bar.getAttribute('data-value')) > 0)!
    expect(Number(costToday.getAttribute('data-value'))).toBeCloseTo(0.00027 + 0.00055, 8)
  })

  it('switches both panels to the hourly window when the dropdown changes', () => {
    render(<UsageCharts tasks={[task({ executions: [usedExecution(100, 50)] })]} />)
    expect(bars()).toHaveLength(14)
    const select = document.querySelector('[data-dsh-part="usage-granularity"]') as HTMLSelectElement
    act(() => {
      select.value = 'hourly'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(bars()).toHaveLength(24)
    act(() => {
      select.value = 'weekly'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(bars()).toHaveLength(8)
  })

  it('shows the empty note when no execution reported usage', () => {
    render(<UsageCharts tasks={[task({ executions: [] })]} endpoints={LOCAL} />)
    expect(bars()).toHaveLength(0)
    expect(panel('tokens').textContent).toContain(t('usage.empty'))
    expect(panel('cost').textContent).toContain(t('usage.empty'))
  })

  it('tells the user to configure pricing when tokens exist but cost cannot be estimated', () => {
    render(<UsageCharts tasks={[task({ executions: [usedExecution(100, 50)] })]} />)
    expect(panel('tokens').querySelector('[data-dsh-part="usage-bar"]')).not.toBeNull()
    expect(bars()).toHaveLength(14) // tokens panel still charts
    expect(panel('cost').textContent).toContain(t('usage.emptyCost'))
  })

  it('clips both charts to the retention window and names the window in the hints', () => {
    render(
      <UsageCharts
        tasks={[task({ executions: [usedExecution(1000, 500)] })]}
        endpoints={LOCAL}
        retentionHours={24}
      />,
    )
    // The daily window normally has 14 buckets; a 24 h retention clips it to
    // the current day plus the partial bucket holding the cutoff.
    expect(panel('tokens').querySelectorAll('[data-dsh-part="usage-bar"]')).toHaveLength(2)
    expect(panel('cost').querySelectorAll('[data-dsh-part="usage-bar"]')).toHaveLength(2)
    // The recent execution still charts, and both panel hints name the window.
    const tokenBars = Array.from(panel('tokens').querySelectorAll('[data-dsh-part="usage-bar"]'))
    const today = tokenBars.find(bar => Number(bar.getAttribute('data-value')) > 0)!
    expect(today.getAttribute('data-value')).toBe('1500')
    expect(panel('tokens').textContent).toContain(t('dash.usageWindow', { hours: '24' }))
    expect(panel('cost').textContent).toContain(t('dash.usageWindow', { hours: '24' }))
  })

  it('keeps the full hourly window under a 24 h retention (nothing older is plotted anyway)', () => {
    render(<UsageCharts tasks={[task({ executions: [usedExecution(100, 50)] })]} retentionHours={24} />)
    const select = document.querySelector('[data-dsh-part="usage-granularity"]') as HTMLSelectElement
    act(() => {
      select.value = 'hourly'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(bars()).toHaveLength(24)
  })

  it('excludes an execution that settled outside the retention window', () => {
    const stale = {
      ...usedExecution(7000, 3000),
      startedAt: Date.now() - 26 * 3_600_000,
      endedAt: Date.now() - 25 * 3_600_000, // settled more than 24 h ago
    }
    render(<UsageCharts tasks={[task({ executions: [stale, usedExecution(1000, 500)] })]} retentionHours={24} />)
    // Only the recent execution contributes: exactly one non-empty bar with its
    // stacked total, wherever the stale run's (excluded) bucket landed.
    const tokenBars = Array.from(panel('tokens').querySelectorAll('[data-dsh-part="usage-bar"]'))
    const populated = tokenBars.filter(bar => Number(bar.getAttribute('data-value')) > 0)
    expect(populated).toHaveLength(1)
    expect(populated[0]!.getAttribute('data-value')).toBe('1500')
  })
})
