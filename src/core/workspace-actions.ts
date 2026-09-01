/**
 * Workspace-level run/pause/stop planning: a pure projection of one
 * workspace's (or the whole board's) actionable tasks and groups. The landing
 * list uses it to decide which control icons are enabled; the controller uses
 * it to fan the per-task / per-group actions out. Framework-free and
 * unit-testable, like the other core projections.
 */
import { orderedGroupMembers, type TaskGroupRecord } from './groups.ts'
import type { TaskRecord } from './tasks.ts'

/** The actionable ids for one workspace's run / pause / stop controls. */
export interface WorkspaceActionPlan {
  /** Ungrouped, approved `todo` tasks with no open run (Run). */
  todoTaskIds: string[]
  /** Non-stopped groups with at least one on-board member in scope (Run). */
  runnableGroupIds: string[]
  /** Groups with at least one running member in scope (Pause). */
  pausableGroupIds: string[]
  /** Running ungrouped tasks in scope (Stop). */
  stoppableTaskIds: string[]
  /** Groups with at least one running member in scope (Stop). */
  stoppableGroupIds: string[]
}

/** Whether a task may be started now: on-board, approved, no open execution. */
export function isRunnable(task: TaskRecord): boolean {
  if (task.archivedAt !== undefined || task.approved === false) return false
  return !task.executions.some(execution => execution.endedAt === undefined)
}

/** Tasks pinned to one workspace (or every task for the All overview). */
export function scopedTasks(tasks: readonly TaskRecord[], workspaceId: string | undefined): readonly TaskRecord[] {
  return workspaceId === undefined ? tasks : tasks.filter(task => task.workspaceId === workspaceId)
}

/**
 * Compute the run/pause/stop plan for one workspace (or the whole board when
 * `workspaceId` is undefined). Run targets ungrouped `todo` tasks only (never
 * backlog — the user starts backlog deliberately), plus every non-stopped
 * group with an in-scope member; Pause stops the in-scope groups currently
 * running; Stop cancels the in-scope running ungrouped tasks and running
 * groups.
 */
export function planWorkspaceActions(
  tasks: readonly TaskRecord[],
  groups: readonly TaskGroupRecord[],
  workspaceId: string | undefined,
): WorkspaceActionPlan {
  const scoped = scopedTasks(tasks, workspaceId)
  const todoTaskIds: string[] = []
  const stoppableTaskIds: string[] = []
  for (const task of scoped) {
    if (task.groupId !== undefined) continue
    if (task.status === 'todo' && isRunnable(task)) todoTaskIds.push(task.id)
    if (task.status === 'running') stoppableTaskIds.push(task.id)
  }
  const runnableGroupIds: string[] = []
  const pausableGroupIds: string[] = []
  const stoppableGroupIds: string[] = []
  for (const group of groups) {
    const members = orderedGroupMembers(group, scoped)
    if (members.length === 0) continue
    if (group.stopped !== true) runnableGroupIds.push(group.id)
    if (members.some(member => member.status === 'running')) {
      pausableGroupIds.push(group.id)
      stoppableGroupIds.push(group.id)
    }
  }
  return { todoTaskIds, runnableGroupIds, pausableGroupIds, stoppableTaskIds, stoppableGroupIds }
}
