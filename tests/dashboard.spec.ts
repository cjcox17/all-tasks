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
})
