/**
 * Usage/cost time series for the dashboard charts: aggregate execution token
 * usage (and the estimated cost derived from it) into fixed recent windows —
 * hourly (last 24 hours), daily (last 14 days), or weekly (last 8 weeks,
 * Monday-aligned) — bucketed by each run's start time in the browser's local
 * time zone. Pure and framework-free so it is unit-testable in isolation.
 *
 * An optional retention cutoff (`since`) applies the dashboard usage
 * retention window the same way the summary cards do: executions that settled
 * before `since` don't count, and buckets that end at or before it are clipped
 * out of the window (the bucket containing the cutoff stays, because runs
 * started there can still settle inside the window). Absent `since` means no
 * window — the full fixed bucket count, all time.
 *
 * Buckets are wall-clock aligned (clock hours, local days, local weeks), not
 * fixed millisecond slices, so DST transitions never split or mislabel a
 * bucket: each execution's bucket key is derived with the same
 * {@link bucketStart} used to generate the window.
 */
import { executionCostUsd, type PricingEndpoint } from './pricing.ts'
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
  /**
   * Estimated USD cost for the bucket: the sum of the per-execution costs of
   * the executions bucketed there (official DeepSeek peak/off-peak rates or
   * the endpoint's own pricing; see pricing.ts). Undefined when no endpoint
   * pricing applies to any execution in the bucket.
   */
  cost: number | undefined
}

/** Inputs for {@link computeUsageSeries}. */
export interface UsageSeriesInput {
  granularity: UsageGranularity
  /** Window end (ms epoch); the last bucket is the one containing this. */
  now: number
  /**
   * Configured endpoints with their pricing; absent disables the cost
   * estimate entirely (mirroring the old "no pricing configured").
   */
  endpoints?: readonly PricingEndpoint[]
  /**
   * Optional retention cutoff (ms epoch, absent = all time): executions that
   * settled before `since` don't count, and buckets that end at or before it
   * are clipped out of the window — the same "settled within the window" rule
   * the summary cards' token totals use (`usageRetentionHours`).
   */
  since?: number
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

/**
 * Step one bucket start one window unit forwards — the mirror of
 * {@link previousBucketStart}, giving a bucket's exclusive end. Uses the same
 * wall-clock arithmetic, so a DST transition still lands on a real local
 * boundary and the two stay in lockstep.
 */
export function nextBucketStart(start: number, granularity: UsageGranularity): number {
  const date = new Date(start)
  if (granularity === 'hourly') date.setHours(date.getHours() + 1)
  else if (granularity === 'daily') date.setDate(date.getDate() + 1)
  else date.setDate(date.getDate() + 7)
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
 * and money just like successes, mirroring {@link computeDashboard}. When a
 * retention `since` is given, executions that settled before it don't count
 * and buckets whose end is at or before it are clipped from the window.
 *
 * The per-bucket cost estimate uses the same rule as the summary card: each
 * execution is billed against the endpoint it ran through (official DeepSeek
 * peak/off-peak rates or the endpoint's own pricing; see pricing.ts) and the
 * costs of the executions bucketed together are summed. A bucket whose
 * executions carry no applicable rate (or no endpoints configured at all)
 * stays undefined.
 */
export function computeUsageSeries(
  tasks: readonly TaskRecord[],
  input: UsageSeriesInput,
): UsageSeriesPoint[] {
  const { granularity, now, endpoints, since } = input
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
  // A retention cutoff clips the visible window to the buckets that can still
  // hold qualifying usage: a bucket is kept while its end (next boundary) is
  // after `since`. The bucket containing `since` stays whole — runs started
  // there can settle inside the window. At least the current bucket always
  // survives, since its end lies in the future.
  if (since !== undefined) {
    while (buckets.length > 1 && nextBucketStart(buckets[0]!.start, granularity) <= since) {
      buckets.shift()
    }
  }
  const byStart = new Map<number, UsageSeriesPoint>(buckets.map(point => [point.start, point]))
  for (const task of tasks) {
    for (const execution of task.executions) {
      if (execution.usage === undefined || execution.endedAt === undefined) continue
      if (since !== undefined && execution.endedAt < since) continue
      const point = byStart.get(bucketStart(execution.startedAt, granularity))
      if (point === undefined) continue
      point.available = true
      point.input += billedInputOf(execution.usage)
      point.output += execution.usage.outputTokens
      point.reasoning += execution.usage.reasoningTokens ?? 0
      // Bill the execution into its start bucket, exactly like the summary
      // card bills each execution. Executions without an applicable rate
      // contribute tokens but no cost, so a bucket of only unpriced runs
      // stays undefined.
      if (endpoints !== undefined) {
        const one = executionCostUsd(execution, task, endpoints)
        if (one !== undefined) point.cost = (point.cost ?? 0) + one
      }
    }
  }
  return buckets
}
