/**
 * Workspace overview list: per-workspace task counts, the list entries, and
 * the expandable per-workspace task directory (groups + ungrouped tasks).
 *
 * Pure functions so the landing view is unit-testable without a DOM. The
 * "All tasks" entry (workspaceId undefined) counts every on-board task
 * across all workspaces, including unassigned ones; a per-workspace entry
 * counts the tasks pinned to that workspace id.
 */
import { orderedGroupMembers, type TaskGroupRecord } from '../../core/groups.ts'
import type { TaskRecord } from '../../core/tasks.ts'

/** Per-workspace (or All) on-board task counts for the landing list. */
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

/** One landing-list row: a workspace and its counts (the All row is separate). */
export interface WorkspaceListEntry {
  /** Workspace-list id (always defined; the All overview row is built by the list). */
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
export function workspaceListEntries(
  tasks: readonly TaskRecord[],
  workspaces: readonly { workspaceId: string; title: string }[],
): WorkspaceListEntry[] {
  const seen = new Set<string>()
  const entries: WorkspaceListEntry[] = []
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

/**
 * Deterministic color hue (0–359) for a workspace or group id, so avatars and
 * group bands keep a stable, distinct color across renders and themes.
 */
export function entityHue(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

/** One expandable directory section: a group plus its on-board members. */
export interface WorkspaceGroupEntry {
  group: TaskGroupRecord
  /** The group's on-board members in scope, in group order. */
  members: TaskRecord[]
}

/**
 * The expandable content of one workspace row (or of the All overview when
 * `workspaceId` is undefined): the workspace's groups that have at least one
 * on-board member in scope, plus its on-board ungrouped tasks. Archived tasks
 * are excluded, matching the kanban's on-board definition.
 */
export interface WorkspaceTaskDirectory {
  /** Groups with members in scope, in snapshot order (empty groups stay in the kanban). */
  grouped: WorkspaceGroupEntry[]
  /** On-board tasks in scope with no group, in task-list order. */
  ungrouped: TaskRecord[]
}

/**
 * Build the expandable directory for one workspace (or the whole board when
 * `workspaceId` is undefined). A scoped view keeps the group's members pinned
 * to that workspace plus its unpinned members, mirroring the kanban's scoping.
 * Groups are workspace-scoped: a workspace row shows only the groups of that
 * workspace; the All row spans every workspace's groups.
 */
export function workspaceTaskDirectory(
  tasks: readonly TaskRecord[],
  groups: readonly TaskGroupRecord[],
  workspaceId: string | undefined,
): WorkspaceTaskDirectory {
  const onBoard = workspaceId === undefined
    ? tasks.filter(task => task.archivedAt === undefined)
    : tasks.filter(task => task.archivedAt === undefined && task.workspaceId === workspaceId)
  const scopeGroups = workspaceId === undefined
    ? groups
    : groups.filter(group => group.workspaceId === workspaceId)
  const grouped: WorkspaceGroupEntry[] = []
  for (const group of scopeGroups) {
    const members = orderedGroupMembers(group, onBoard)
    if (members.length > 0) grouped.push({ group, members })
  }
  return { grouped, ungrouped: onBoard.filter(task => task.groupId === undefined) }
}
