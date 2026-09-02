/**
 * Usage/cost time series: bucket alignment, window generation, execution
 * aggregation, and per-bucket cost estimates for the dashboard charts.
 */
import { describe, expect, it } from 'vitest'
import {
  USAGE_WINDOW,
  billedInputOf,
  bucketStart,
  computeUsageSeries,
  previousBucketStart,
} from '../src/core/usage-series.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'T', description: '', prompt: '' }, 0, `t-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  }
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'e',
    sessionId: 's',
    startedAt: 0,
    endedAt: 1,
    result: 'succeeded',
    error: undefined,
    ...overrides,
  }
}

/** Local-time epoch helper (tests stay timezone independent). */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime()
}

describe('bucketStart', () => {
  it('aligns an hourly timestamp to the top of its local hour', () => {
    expect(bucketStart(at(2025, 2, 12, 14, 23), 'hourly')).toBe(at(2025, 2, 12, 14))
    expect(bucketStart(at(2025, 2, 12, 14, 0), 'hourly')).toBe(at(2025, 2, 12, 14))
  })

  it('aligns a daily timestamp to local midnight', () => {
    expect(bucketStart(at(2025, 2, 12, 23, 59), 'daily')).toBe(at(2025, 2, 12))
  })

  it('aligns a weekly timestamp to the Monday of its local week', () => {
    // Mar 2025: the 1st is a Saturday, so Mon 3rd / Wed 5th / Sun 9th / Mon 10th / Wed 12th.
    expect(bucketStart(at(2025, 2, 12, 15, 30), 'weekly')).toBe(at(2025, 2, 10))
    expect(bucketStart(at(2025, 2, 9, 23, 59), 'weekly')).toBe(at(2025, 2, 3))
    expect(bucketStart(at(2025, 2, 10, 0, 0), 'weekly')).toBe(at(2025, 2, 10))
  })
})

describe('previousBucketStart', () => {
  it('steps back one clock hour, local day, or local week', () => {
    expect(previousBucketStart(at(2025, 2, 12, 14), 'hourly')).toBe(at(2025, 2, 12, 13))
    expect(previousBucketStart(at(2025, 2, 12), 'daily')).toBe(at(2025, 2, 11))
    expect(previousBucketStart(at(2025, 2, 10), 'weekly')).toBe(at(2025, 2, 3))
  })
})

describe('computeUsageSeries', () => {
  it('emits the fixed recent window per granularity, aligned and ascending', () => {
    const now = at(2025, 2, 12, 15, 30)
    for (const granularity of ['hourly', 'daily', 'weekly'] as const) {
      const series = computeUsageSeries([], { granularity, now })
      expect(series).toHaveLength(USAGE_WINDOW[granularity])
      expect(series.at(-1)!.start).toBe(bucketStart(now, granularity))
      // Every start is aligned, strictly increasing, and has a label.
      for (let index = 0; index < series.length; index += 1) {
        expect(bucketStart(series[index]!.start, granularity)).toBe(series[index]!.start)
        expect(series[index]!.label.length).toBeGreaterThan(0)
        if (index > 0) expect(series[index]!.start).toBeGreaterThan(series[index - 1]!.start)
      }
      expect(series[0]!.available).toBe(false)
      expect(series[0]!.cost).toBeUndefined()
    }
  })

  it('buckets executions by run start time and aggregates billed input, output, and reasoning', () => {
    const now = at(2025, 2, 12, 15, 30)
    const tasks = [
      task({
        executions: [
          execution({
            id: 'e1',
            startedAt: at(2025, 2, 12, 14, 10),
            usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, reasoningTokens: 50 },
          }),
          execution({
            id: 'e2',
            startedAt: at(2025, 2, 11, 9, 0),
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
          // A still-running execution's partial usage is not counted.
          execution({ id: 'e3', startedAt: at(2025, 2, 12, 13, 0), endedAt: undefined, result: undefined, usage: { inputTokens: 999, outputTokens: 999 } }),
          // A settled run the adapter disclosed no usage for contributes nothing.
          execution({ id: 'e4', startedAt: at(2025, 2, 12, 13, 0) }),
        ],
      }),
    ]
    const daily = computeUsageSeries(tasks, { granularity: 'daily', now })
    expect(daily.at(-1)!.available).toBe(true)
    expect(daily.at(-1)!.input).toBe(1200) // 1000 uncached + 200 cache read
    expect(daily.at(-1)!.output).toBe(500)
    expect(daily.at(-1)!.reasoning).toBe(50)
    expect(daily.at(-2)!.input).toBe(10)
    expect(daily.at(-2)!.output).toBe(5)
    // Buckets without usage stay unavailable.
    expect(daily[0]!.available).toBe(false)
    expect(daily[0]!.input).toBe(0)

    const hourly = computeUsageSeries(tasks, { granularity: 'hourly', now })
    const bucket = hourly.find(point => point.start === at(2025, 2, 12, 14))
    expect(bucket?.input).toBe(1200)
    expect(bucket?.output).toBe(500)
  })

  it('estimates per-bucket cost from usage and pricing, and omits it otherwise', () => {
    const now = at(2025, 2, 12, 15, 30)
    const tasks = [
      task({
        executions: [
          execution({ id: 'e1', startedAt: at(2025, 2, 12, 14, 0), usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }),
        ],
      }),
    ]
    const pricing = { inputPerMillion: 0.27, outputPerMillion: 1.10 }
    const withPricing = computeUsageSeries(tasks, { granularity: 'daily', now, pricing })
    const today = withPricing.at(-1)!
    expect(today.cost).toBeCloseTo(0.27 + 0.55)
    // Unused buckets carry no cost, even with pricing configured.
    expect(withPricing[0]!.cost).toBeUndefined()

    const withoutPricing = computeUsageSeries(tasks, { granularity: 'daily', now })
    expect(withoutPricing.at(-1)!.cost).toBeUndefined()
  })

  it('counts cancelled and failed runs (they consumed tokens) like successes', () => {
    const now = at(2025, 2, 12, 15, 30)
    const tasks = [
      task({
        executions: [
          execution({ id: 'e1', startedAt: at(2025, 2, 12, 10, 0), result: 'failed', error: 'x', usage: { inputTokens: 100, outputTokens: 50 } }),
          execution({ id: 'e2', startedAt: at(2025, 2, 12, 11, 0), result: 'cancelled', error: 'stopped', usage: { inputTokens: 20, outputTokens: 10 } }),
        ],
      }),
    ]
    const daily = computeUsageSeries(tasks, { granularity: 'daily', now })
    expect(daily.at(-1)!.input).toBe(120)
    expect(daily.at(-1)!.output).toBe(60)
  })
})

describe('billedInputOf', () => {
  it('sums uncached input with cache reads and writes', () => {
    expect(billedInputOf({ inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2 })).toBe(15)
    expect(billedInputOf({ inputTokens: 10 })).toBe(10)
  })
})
