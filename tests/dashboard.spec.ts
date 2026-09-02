/**
 * Dashboard aggregation: the board-wide summary cards (counts, token totals,
 * success rate, and estimated cost).
 */
import { describe, expect, it } from 'vitest'
import { computeDashboard, tokenTotalsOf } from '../src/core/dashboard.ts'
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

  it('drops executions settled before `since` and keeps newer and open ones', () => {
    const tasks = [
      task({
        executions: [
          { id: 'old', sessionId: 's', startedAt: 0, endedAt: 1_000, result: 'succeeded', error: undefined, usage: { inputTokens: 10, outputTokens: 5 } },
          { id: 'boundary', sessionId: 's', startedAt: 0, endedAt: 2_000, result: 'succeeded', error: undefined, usage: { inputTokens: 20, outputTokens: 10 } },
          { id: 'new', sessionId: 's', startedAt: 0, endedAt: 5_000, result: 'succeeded', error: undefined, usage: { inputTokens: 30, outputTokens: 15 } },
          { id: 'open', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined, usage: { inputTokens: 40, outputTokens: 20 } },
        ],
      }),
    ]
    // The window boundary is inclusive: the run settled exactly at `since` counts.
    expect(tokenTotalsOf(tasks, 2_000)).toEqual({ input: 90, output: 45, reasoning: 0, available: true })
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

  it('computes a cost estimate from token usage and pricing, and omits it otherwise', () => {
    const withUsage = task({
      executions: [{ id: 'e', sessionId: 's', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined, usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }],
    })
    expect(computeDashboard([withUsage], [], { inputPerMillion: 0.27, outputPerMillion: 1.10 })?.cost).toBeCloseTo(0.27 + 0.55)
    expect(computeDashboard([withUsage], [])?.cost).toBeUndefined()
    expect(computeDashboard([task()], [], { inputPerMillion: 0.27, outputPerMillion: 1.10 })?.cost).toBeUndefined()
  })

  it('narrows token totals and the cost estimate to the retention window', () => {
    const now = 10_000_000
    const hour = 3_600_000
    const withUsage = task({
      executions: [
        { id: 'old', sessionId: 's', startedAt: 0, endedAt: now - 48 * hour, result: 'succeeded', error: undefined, usage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
        { id: 'new', sessionId: 's', startedAt: 0, endedAt: now - 2 * hour, result: 'succeeded', error: undefined, usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 } },
      ],
    })
    const metrics = computeDashboard([withUsage], [], { inputPerMillion: 1, outputPerMillion: 1 }, 24, now)
    expect(metrics.tokens).toEqual({ input: 2_000_000, output: 1_000_000, reasoning: 0, available: true })
    expect(metrics.cost).toBeCloseTo(3)
  })

  it('treats absent or zero retention hours as all time', () => {
    const withUsage = task({
      executions: [{ id: 'e', sessionId: 's', startedAt: 0, endedAt: 1, result: 'succeeded', error: undefined, usage: { inputTokens: 100, outputTokens: 50 } }],
    })
    expect(computeDashboard([withUsage], [], undefined, undefined, 10_000).tokens)
      .toEqual({ input: 100, output: 50, reasoning: 0, available: true })
    expect(computeDashboard([withUsage], [], undefined, 0, 10_000).tokens)
      .toEqual({ input: 100, output: 50, reasoning: 0, available: true })
  })
})
