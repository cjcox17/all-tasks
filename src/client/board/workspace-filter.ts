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
 * Workspaces deleted from the runtime list (removed in the sidebar) leave the
 * board together with their tasks and groups: a task or group pinned to an id
 * missing from the loaded workspace baseline counts as vanished and is
 * filtered out by {@link boardTasks} / {@link boardGroups}. The ledger keeps
 * the pins untouched — this is a view-level filter only.
 *
 * Pure functions so the column splitting is unit-testable without a DOM.
 */
import type { TaskGroupRecord } from '../../core/groups.ts'
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

/**
 * The live workspace ids from the runtime workspace list — the board's
 * visible workspace set. A pin naming an id outside this set belongs to a
 * workspace that no longer exists (deleted in the sidebar); such tasks and
 * groups are hidden from the board (see {@link boardTasks} / {@link
 * boardGroups}). Only meaningful once the workspace baseline has loaded.
 */
export function liveWorkspaceIds(workspaces: readonly { workspaceId: string }[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const workspace of workspaces) ids.add(workspace.workspaceId)
  return ids
}

/** True when the record's workspace pin names a workspace missing from the runtime list. */
export function isVanishedWorkspacePin(target: { workspaceId?: string }, liveIds: ReadonlySet<string>): boolean {
  return target.workspaceId !== undefined && !liveIds.has(target.workspaceId)
}

/** The board's visible tasks: unassigned or pinned to a live workspace. */
export function boardTasks(tasks: readonly TaskRecord[], liveIds: ReadonlySet<string>): TaskRecord[] {
  return tasks.filter(task => !isVanishedWorkspacePin(task, liveIds))
}

/** The board's visible groups: unassigned-scope or scoped to a live workspace. */
export function boardGroups(groups: readonly TaskGroupRecord[], liveIds: ReadonlySet<string>): TaskGroupRecord[] {
  return groups.filter(group => !isVanishedWorkspacePin(group, liveIds))
}
