/**
 * Dashboard aggregation: the board-wide summary cards (counts, token totals,
 * success rate, and estimated cost).
 */
import { describe, expect, it } from 'vitest'
import { computeDashboard, tokenTotalsOf } from '../src/core/dashboard.ts'
import { DEEPSEEK_OFFICIAL_PROVIDER } from '../src/core/pricing.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'T', description: '', prompt: '' }, 0, `t-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  }
}

const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1'], createdAt: 0, updatedAt: 0, offPeakOnly: false }

describe('tokenTotalsOf', () => {
  it('sums billed input (uncached + cache) and output across executions', () => {
    const tasks = [
      task({
        executions: [
          { id: 'e1', sessionId: 's1', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } },
          { id: 'e2', sessionId: 's2', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined, usage: { inputTokens: 20, outputTokens: 10, cacheWriteTokens: 2, reasoningTokens: 8 } },
        ],
      }),
    ]
    expect(tokenTotalsOf(tasks)).toEqual({ input: 35, output: 15, reasoning: 8, available: true })
  })

  it('reports unavailable when no execution carried usage', () => {
    expect(tokenTotalsOf([task({ executions: [] })]).available).toBe(false)
  })
})

describe('computeDashboard', () => {
  it('counts every status bucket and derives success rate, groups, and runs', () => {
    const tasks = [
      task({ id: 't1', status: 'todo' }),
      task({ id: 't2', status: 'todo', approved: false }),
      task({ id: 't3', status: 'running', executions: [{ id: 'e', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }] }),
      task({ id: 't4', status: 'done', executions: [{ id: 'e4', sessionId: 's', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined }] }),
      task({ id: 't5', status: 'failed', executions: [{ id: 'e5', sessionId: 's', startedAt: 0, endedAt: 1, result: 'failed', error: 'x' }] }),
      task({ id: 't6', status: 'todo', schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 1, lastTriggeredAt: undefined } }),
      { ...task({ id: 't7', status: 'done' }), archivedAt: 1 },
    ]
    const metrics = computeDashboard(tasks, [GROUP])
    expect(metrics.total).toBe(6)
    expect(metrics.todo).toBe(2) // t1 + t6
    expect(metrics.pending).toBe(1)
    expect(metrics.running).toBe(1)
    expect(metrics.completed).toBe(1)
    expect(metrics.failed).toBe(1)
    expect(metrics.scheduled).toBe(1)
    expect(metrics.groups).toBe(1)
    expect(metrics.runs).toBe(3) // e + e4 + e5
    expect(metrics.successRate).toBeCloseTo(0.5)
  })

  describe('cost estimate (per-execution pricing)', () => {
    // Mon 2026-07-13 UTC: 02:00 is inside the peak window, 12:00 is off-peak.
    const PEAK = Date.UTC(2026, 6, 13, 2)
    const OFF_PEAK = Date.UTC(2026, 6, 13, 12)
    const OFFICIAL: Array<{ id: string; provider: string; defaultModel: string }> = [
      { id: 'ds', provider: DEEPSEEK_OFFICIAL_PROVIDER, defaultModel: 'deepseek-v4-flash' },
    ]

    function usageExec(startedAt: number, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, endpointId?: string) {
      return { id: 'e', sessionId: 's', startedAt, launchedAt: startedAt, endedAt: startedAt + 1000, result: 'succeeded' as const, error: undefined, ...(endpointId === undefined ? {} : { endpointId }), usage }
    }

    it('bills official DeepSeek runs at peak or off-peak official rates by launch instant', () => {
      const peak = task({ executions: [usageExec(PEAK, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'ds')] })
      // deepseek-v4-flash peak: 1M miss @ 0.44 + 1M out @ 1.32.
      expect(computeDashboard([peak], [], OFFICIAL).cost).toBeCloseTo(0.44 + 1.32)
      const offPeak = task({ executions: [usageExec(OFF_PEAK, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'ds')] })
      // Off-peak = half of peak: 0.22 + 0.66.
      expect(computeDashboard([offPeak], [], OFFICIAL).cost).toBeCloseTo(0.22 + 0.66)
      // A weekend run inside a weekday peak window is fully off-peak.
      const weekend = task({ executions: [usageExec(Date.UTC(2026, 6, 18, 8), { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'ds')] })
      expect(computeDashboard([weekend], [], OFFICIAL).cost).toBeCloseTo(0.22 + 0.66)
    })

    it('bills cache-read input at the cache-hit rate and cache writes at the miss rate', () => {
      const t = task({ executions: [usageExec(OFF_PEAK, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, 'ds')] })
      expect(computeDashboard([t], [], OFFICIAL).cost).toBeCloseTo(0.007 + 0.22)
    })

    it('bills local endpoints at their own configured rates', () => {
      const local = [{ id: 'lm', provider: 'lm-studio', costPerMillionInputTokens: 1, costPerMillionOutputTokens: 2 }]
      const t = task({ executions: [usageExec(0, { inputTokens: 1_000_000, outputTokens: 500_000 }, 'lm')] })
      expect(computeDashboard([t], [], local).cost).toBeCloseTo(1 + 1) // 1M in @ 1 + 0.5M out @ 2
    })

    it('omits the cost without an applicable rate and when no endpoints are supplied', () => {
      const unpriced = [{ id: 'lm', provider: 'lm-studio' }]
      const t = task({ executions: [usageExec(0, { inputTokens: 1_000_000, outputTokens: 1 }, 'lm')] })
      expect(computeDashboard([t], [], unpriced).cost).toBeUndefined()
      expect(computeDashboard([t], []).cost).toBeUndefined()
      expect(computeDashboard([task()], [], OFFICIAL).cost).toBeUndefined()
    })

    it('sums per-execution costs across tasks and executions', () => {
      const peak = task({ executions: [usageExec(PEAK, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'ds')] })
      const offPeak = task({ executions: [usageExec(OFF_PEAK, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'ds')] })
      expect(computeDashboard([peak, offPeak], [], OFFICIAL).cost).toBeCloseTo(0.44 + 1.32 + 0.22 + 0.66)
    })
  })
})
