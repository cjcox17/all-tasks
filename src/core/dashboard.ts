/**
 * Board-wide dashboard aggregation: the summary cards above the workspace
 * list. Pure and framework-free so it is unit-testable in isolation. Cost is
 * an estimate — it multiplies the captured token usage by the configured
 * per-million prices and is undefined when tokens or pricing are absent.
 */
import type { TaskGroupRecord } from './groups.ts'
import type { TaskRecord } from './tasks.ts'

/** Per-token pricing for the cost estimate (USD per 1M tokens). */
export interface CostPricingInput {
  inputPerMillion: number
  outputPerMillion: number
}

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
  /** Estimated USD spend; undefined without token usage and pricing. */
  cost: number | undefined
}

/** Sum the token usage recorded on every execution of the given tasks. */
export function tokenTotalsOf(tasks: readonly TaskRecord[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, reasoning: 0, available: false }
  for (const task of tasks) {
    for (const execution of task.executions) {
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

/**
 * Compute the board-wide dashboard metrics from the ledger snapshot.
 * Archived tasks are excluded from every count (they leave the board).
 */
export function computeDashboard(
  tasks: readonly TaskRecord[],
  groups: readonly TaskGroupRecord[],
  pricing?: CostPricingInput,
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
  metrics.tokens = tokenTotalsOf(tasks)
  if (pricing !== undefined && metrics.tokens.available) {
    metrics.cost = (metrics.tokens.input / 1_000_000) * pricing.inputPerMillion
      + (metrics.tokens.output / 1_000_000) * pricing.outputPerMillion
  }
  return metrics
}
