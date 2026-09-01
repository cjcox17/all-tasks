/**
 * Workspace overview grid: per-workspace task counts and the grid entries.
 *
 * Pure functions so the landing view is unit-testable without a DOM. The
 * "All tasks" entry (workspaceId undefined) counts every on-board task
 * across all workspaces, including unassigned ones; a per-workspace entry
 * counts the tasks pinned to that workspace id.
 */
import type { TaskRecord } from '../../core/tasks.ts'

/** Per-workspace (or All) on-board task counts for the landing grid. */
export interface WorkspaceCounts {
  /** Every on-board task (the sum of the status buckets; scheduled overlaps). */
  total: number
  /** backlog/todo and approved. */
  todo: number
  /** backlog/todo and unapproved (waiting for approval). */
  pending: number
  /** running. */
  working: number
  /** Non-archived tasks with an armed cron. */
  scheduled: number
  /** done. */
  finished: number
  /** failed. */
  failed: number
}

/** One landing-grid card: a workspace and its counts (the All card is separate). */
export interface WorkspaceGridEntry {
  /** Workspace-list id (always defined; the All overview card is built by the grid). */
  workspaceId: string
  /** Display title (runtime workspace title, or the id for a vanished workspace). */
  title: string
  counts: WorkspaceCounts
}

/**
 * Count the on-board tasks of one workspace (or of every workspace when
 * `workspaceId` is undefined). Archived tasks are excluded from every bucket;
 * a task with an armed cron is also counted in the scheduled bucket.
 */
export function countWorkspaceTasks(
  tasks: readonly TaskRecord[],
  workspaceId: string | undefined,
): WorkspaceCounts {
  const counts: WorkspaceCounts = { total: 0, todo: 0, pending: 0, working: 0, scheduled: 0, finished: 0, failed: 0 }
  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    if (workspaceId !== undefined && task.workspaceId !== workspaceId) continue
    counts.total += 1
    if (task.status === 'backlog' || task.status === 'todo') {
      if (task.approved === false) counts.pending += 1
      else counts.todo += 1
    } else if (task.status === 'running') counts.working += 1
    else if (task.status === 'done') counts.finished += 1
    else if (task.status === 'failed') counts.failed += 1
    if (task.schedule?.enabled === true) counts.scheduled += 1
  }
  return counts
}

/**
 * Build the landing entries: one per runtime workspace (in runtime order),
 * plus workspaces pinned by tasks but missing from the runtime list (deleted
 * or renamed workspaces stay visible with the id as the title), so no
 * pinned tasks ever disappear from the overview. The "All tasks" entry is
 * the caller's concern (it carries localized copy).
 */
export function workspaceGridEntries(
  tasks: readonly TaskRecord[],
  workspaces: readonly { workspaceId: string; title: string }[],
): WorkspaceGridEntry[] {
  const seen = new Set<string>()
  const entries: WorkspaceGridEntry[] = []
  for (const workspace of workspaces) {
    seen.add(workspace.workspaceId)
    entries.push({
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      counts: countWorkspaceTasks(tasks, workspace.workspaceId),
    })
  }
  for (const task of tasks) {
    if (task.workspaceId === undefined || seen.has(task.workspaceId)) continue
    seen.add(task.workspaceId)
    entries.push({
      workspaceId: task.workspaceId,
      title: task.workspaceId,
      counts: countWorkspaceTasks(tasks, task.workspaceId),
    })
  }
  return entries
}
