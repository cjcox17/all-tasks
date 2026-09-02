/**
 * Usage/cost time series for the dashboard charts: aggregate execution token
 * usage (and the estimated cost derived from it) into fixed recent windows —
 * hourly (last 24 hours), daily (last 14 days), or weekly (last 8 weeks,
 * Monday-aligned) — bucketed by each run's start time in the browser's local
 * time zone. Pure and framework-free so it is unit-testable in isolation.
 *
 * Buckets are wall-clock aligned (clock hours, local days, local weeks), not
 * fixed millisecond slices, so DST transitions never split or mislabel a
 * bucket: each execution's bucket key is derived with the same
 * {@link bucketStart} used to generate the window.
 */
import type { CostPricingInput } from './dashboard.ts'
import type { ExecutionUsage, TaskRecord } from './tasks.ts'

/** How finely the usage graphs bucket executions. */
export type UsageGranularity = 'hourly' | 'daily' | 'weekly'

/** Bucket counts per granularity (the fixed recent window). */
export const USAGE_WINDOW: Record<UsageGranularity, number> = {
  hourly: 24,
  daily: 14,
  weekly: 8,
}

/** One windowed bucket of the usage graphs. */
export interface UsageSeriesPoint {
  /** Bucket start (ms epoch, aligned to the granularity's local boundary). */
  start: number
  /** Human axis label for the bucket (browser locale). */
  label: string
  /** Billed input = uncached input + cache read + cache write. */
  input: number
  output: number
  reasoning: number
  /** Whether any execution in this bucket reported usage. */
  available: boolean
  /** Estimated USD cost for the bucket; undefined without usage and pricing. */
  cost: number | undefined
}

/** Inputs for {@link computeUsageSeries}. */
export interface UsageSeriesInput {
  granularity: UsageGranularity
  /** Window end (ms epoch); the last bucket is the one containing this. */
  now: number
  pricing?: CostPricingInput
}

/** Billed input tokens of one execution (uncached + cache read + cache write). */
export function billedInputOf(usage: Pick<ExecutionUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Bucket start for a timestamp at the given granularity, aligned to local
 * wall-clock boundaries: the top of the hour, local midnight, or the local
 * Monday (ISO weeks) of the containing week.
 */
export function bucketStart(ts: number, granularity: UsageGranularity): number {
  const date = new Date(ts)
  if (granularity === 'hourly') {
    date.setMinutes(0, 0, 0)
    return date.getTime()
  }
  date.setHours(0, 0, 0, 0)
  if (granularity === 'daily') return date.getTime()
  const daysSinceMonday = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - daysSinceMonday)
  return date.getTime()
}

/**
 * Step one bucket start one window unit backwards. Uses wall-clock arithmetic
 * (`setHours`/`setDate`) so a DST transition still lands on a real local
 * boundary, exactly like {@link bucketStart} — the two stay in lockstep.
 */
export function previousBucketStart(start: number, granularity: UsageGranularity): number {
  const date = new Date(start)
  if (granularity === 'hourly') date.setHours(date.getHours() - 1)
  else if (granularity === 'daily') date.setDate(date.getDate() - 1)
  else date.setDate(date.getDate() - 7)
  return date.getTime()
}

/** Human axis label for a bucket start, in the browser locale. */
export function bucketLabel(start: number, granularity: UsageGranularity): string {
  const date = new Date(start)
  if (granularity === 'hourly') {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

/**
 * Aggregate every execution that reported usage into the recent window at the
 * requested granularity, oldest bucket first. Executions without usage (the
 * adapter disclosed none, or the run settled before usage capture shipped)
 * contribute nothing; cancelled and failed runs count — they consumed tokens
 * and money just like successes, mirroring {@link computeDashboard}.
 *
 * The per-bucket cost estimate uses the same rule as the summary card: billed
 * input + output times the configured per-million prices, undefined when
 * pricing is not configured or the bucket has no usage.
 */
export function computeUsageSeries(
  tasks: readonly TaskRecord[],
  input: UsageSeriesInput,
): UsageSeriesPoint[] {
  const { granularity, now, pricing } = input
  const count = USAGE_WINDOW[granularity]
  // Build the window backwards from the bucket containing `now`, so the last
  // bucket is always the current hour/day/week and earlier buckets are
  // strictly older (with empty buckets in between when nothing ran).
  const buckets: UsageSeriesPoint[] = []
  let cursor = bucketStart(now, granularity)
  for (let index = 0; index < count; index += 1) {
    buckets.unshift({
      start: cursor,
      label: bucketLabel(cursor, granularity),
      input: 0,
      output: 0,
      reasoning: 0,
      available: false,
      cost: undefined,
    })
    cursor = previousBucketStart(cursor, granularity)
  }
  const byStart = new Map<number, UsageSeriesPoint>(buckets.map(point => [point.start, point]))
  for (const task of tasks) {
    for (const execution of task.executions) {
      if (execution.usage === undefined || execution.endedAt === undefined) continue
      const point = byStart.get(bucketStart(execution.startedAt, granularity))
      if (point === undefined) continue
      point.available = true
      point.input += billedInputOf(execution.usage)
      point.output += execution.usage.outputTokens
      point.reasoning += execution.usage.reasoningTokens ?? 0
    }
  }
  if (pricing !== undefined) {
    for (const point of buckets) {
      if (point.available) {
        point.cost = (point.input / 1_000_000) * pricing.inputPerMillion
          + (point.output / 1_000_000) * pricing.outputPerMillion
      }
    }
  }
  return buckets
}
