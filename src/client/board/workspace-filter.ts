/**
 * Workspace scoping for the board view.
 *
 * The kanban can be scoped to a single execution workspace: a column then
 * shows the tasks pinned to that workspace (`task.workspaceId` — the
 * workspace the task's session runs in) followed by an "Unassigned" section
 * for tasks with no pin (they fall back to the recent workspace at run time),
 * so nothing disappears from any view. The default "All workspaces" view is
 * the plain general overview, unchanged.
 *
 * Pure functions so the column splitting is unit-testable without a DOM.
 */
import type { TaskRecord } from '../../core/tasks.ts'

/**
 * True when the task passes the active workspace filter. Unassigned tasks
 * (no `workspaceId` pin) pass every workspace view and land in the
 * "Unassigned" section; `undefined` filter means the general overview.
 */
export function matchesWorkspace(task: TaskRecord, workspaceFilter: string | undefined): boolean {
  return workspaceFilter === undefined || task.workspaceId === undefined || task.workspaceId === workspaceFilter
}

/**
 * Split a (status- and search-filtered) task list for the active workspace
 * filter into the workspace's pinned tasks and the unassigned remainder.
 * Without a filter the whole list is "pinned" and there is no unassigned
 * section (the All view renders exactly as before).
 */
export function splitWorkspaceTasks(
  tasks: readonly TaskRecord[],
  workspaceFilter: string | undefined,
): { pinned: readonly TaskRecord[]; unassigned: readonly TaskRecord[] } {
  if (workspaceFilter === undefined) return { pinned: tasks, unassigned: [] }
  return {
    pinned: tasks.filter(task => task.workspaceId === workspaceFilter),
    unassigned: tasks.filter(task => task.workspaceId === undefined),
  }
}
