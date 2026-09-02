/**
 * Board-wide dashboard aggregation: the summary cards above the workspace
 * list. Pure and framework-free so it is unit-testable in isolation. Cost is
 * an estimate — each settled execution is billed against the endpoint it ran
 * through (DeepSeek's official peak/off-peak rates for the official route,
 * the endpoint's own configured prices for local compute; see pricing.ts) and
 * the results are summed; it is undefined when no execution carries usage and
 * a rate.
 *
 * An optional retention window (`usageRetentionHours`) narrows the token
 * totals and the cost estimate to executions that settled inside the window:
 * set to 24, only usage from the last 24 hours counts. It is a display
 * window — the ledger keeps every execution; nothing is pruned.
 */
import type { TaskGroupRecord } from './groups.ts'
import { executionCostUsd, type PricingEndpoint } from './pricing.ts'
import type { TaskRecord } from './tasks.ts'

/** Aggregated token accounting across every execution that reported usage. */
export interface TokenTotals {
  /** Billed input = uncached input + cache read + cache write. */
  input: number
  output: number
  reasoning: number
  /** Whether any settled execution reported usage (versus a zero total). */
  available: boolean
}

/** The dashboard's card metrics. */
export interface DashboardMetrics {
  total: number
  /** backlog/todo, approved. */
  todo: number
  /** backlog/todo, unapproved (waiting for approval). */
  pending: number
  /** status running (includes runs queued for a slot/endpoint/window). */
  running: number
  /** open executions held waiting for an endpoint, slot, or window. */
  queued: number
  completed: number
  failed: number
  /** tasks with an armed cron. */
  scheduled: number
  groups: number
  /** groups with at least one running member. */
  activeGroups: number
  /** total execution attempts across every task. */
  runs: number
  tokens: TokenTotals
  /** done / (done + failed), or undefined when nothing has settled either way. */
  successRate: number | undefined
  /**
   * Estimated USD spend: the sum of each execution's cost (official DeepSeek
   * peak/off-peak rates, or the endpoint's own pricing); undefined when no
   * execution reported usage with an applicable rate.
   */
  cost: number | undefined
}

/**
 * Sum the token usage recorded on every execution of the given tasks.
 * `since` (ms epoch) drops executions that settled before it — usage is
 * captured at settlement — while still-open executions always count. Absent
 * `since` means no window (all time).
 */
export function tokenTotalsOf(tasks: readonly TaskRecord[], since?: number): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, reasoning: 0, available: false }
  for (const task of tasks) {
    for (const execution of task.executions) {
      if (since !== undefined && execution.endedAt !== undefined && execution.endedAt < since) continue
      const usage = execution.usage
      if (usage === undefined) continue
      totals.available = true
      totals.input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      totals.output += usage.outputTokens
      totals.reasoning += usage.reasoningTokens ?? 0
    }
  }
  return totals
}

/** One hour in milliseconds, used by the dashboard retention window. */
export const HOUR_MS = 3_600_000

/**
 * Compute the board-wide dashboard metrics from the ledger snapshot.
 * Archived tasks are excluded from every count (they leave the board).
 * `usageRetentionHours` (0/undefined = all time) narrows the token totals and
 * the cost estimate to executions settled within that many hours of `now`.
 * @param tasks - the board's tasks.
 * @param groups - the board's task groups.
 * @param endpoints - configured endpoints with their pricing; absent disables
 *   the cost estimate entirely (mirroring the old "no pricing configured").
 */
export function computeDashboard(
  tasks: readonly TaskRecord[],
  groups: readonly TaskGroupRecord[],
  endpoints?: readonly PricingEndpoint[],
  usageRetentionHours?: number,
  now = Date.now(),
): DashboardMetrics {
  const metrics: DashboardMetrics = {
    total: 0,
    todo: 0,
    pending: 0,
    running: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    scheduled: 0,
    groups: groups.length,
    activeGroups: 0,
    runs: 0,
    tokens: { input: 0, output: 0, reasoning: 0, available: false },
    successRate: undefined,
    cost: undefined,
  }
  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    metrics.total += 1
    metrics.runs += task.executions.length
    if (task.status === 'backlog' || task.status === 'todo') {
      if (task.approved === false) metrics.pending += 1
      else metrics.todo += 1
    } else if (task.status === 'running') {
      metrics.running += 1
      if (task.executions.some(execution => execution.endedAt === undefined && execution.queuedAt !== undefined)) {
        metrics.queued += 1
      }
    } else if (task.status === 'done') metrics.completed += 1
    else if (task.status === 'failed') metrics.failed += 1
    if (task.schedule?.enabled === true) metrics.scheduled += 1
  }
  for (const group of groups) {
    if (tasks.some(task => task.groupId === group.id && task.archivedAt === undefined && task.status === 'running')) {
      metrics.activeGroups += 1
    }
  }
  const settled = metrics.completed + metrics.failed
  if (settled > 0) metrics.successRate = metrics.completed / settled
  const since = usageRetentionHours !== undefined && usageRetentionHours > 0
    ? now - usageRetentionHours * HOUR_MS
    : undefined
  metrics.tokens = tokenTotalsOf(tasks, since)
  // The cost estimate follows the token totals: it spans every retained
  // execution (archived tasks included, like the old single-rate estimate).
  if (endpoints !== undefined) {
    let cost: number | undefined
    for (const task of tasks) {
      for (const execution of task.executions) {
        // Same retention rule as the token totals: an execution settled before
        // the window drops out of the estimate, still-open ones always count.
        if (since !== undefined && execution.endedAt !== undefined && execution.endedAt < since) continue
        const one = executionCostUsd(execution, task, endpoints)
        if (one === undefined) continue
        cost = (cost ?? 0) + one
      }
    }
    metrics.cost = cost
  }
  return metrics
}
