/**
 * Update-task use case: apply an editable-field patch (title/description/
 * prompt plus the execution targets workspaceId/mode/model/permission) with a
 * fresh updatedAt. Pure ledger transition (no persistence or notify — the
 * controller orchestrates those).
 *
 * An explicit `undefined` in the patch clears an execution-target field
 * (the task falls back to the runtime default); content fields are trimmed
 * and never cleared. An unknown permission string is ignored so stale UI
 * can never persist a value the execution service rejects.
 */
import { normalizeEndpointList } from '../endpoints.ts'
import { isTaskPermission, normalizeModelSelection, normalizeTargetId, type TaskModelSelection, type TaskRecord, type TaskPermission } from '../tasks.ts'

/** Editable fields on a task (the update patch surface). */
export type TaskUpdatePatch = Partial<Pick<TaskRecord, 'title' | 'description' | 'prompt' | 'workspaceId' | 'mode' | 'permission'>> & {
  /**
   * Model selection the execution session must be pinned to; `null` clears
   * the pin and the task falls back to the deployment default.
   */
  model?: TaskModelSelection | null
  /**
   * Model selection the execution session is pinned to during the plan phase;
   * `null` clears the pin and the task falls back to the group's / workspace's
   * plan-model default (or no plan phase at all).
   */
  planModel?: TaskModelSelection | null
  /**
   * Priority-ordered endpoint ids to route this task through; `null` (or an
   * empty array) clears the pin and the global default endpoint list applies.
   */
  endpoints?: string[] | null
  /**
   * The task group this task belongs to; `null` clears the membership and the
   * task becomes ungrouped (the group's order is synced by the caller).
   */
  groupId?: string | null
}

/**
 * The fields that edit the task's content (what the user reads and what the
 * next execution sends). Unlike the execution targets they stay editable only
 * while the task has never started executing — after the first run the
 * recorded prompt is the record of what actually ran, so it becomes read-only.
 */
export const TASK_CONTENT_FIELDS = ['title', 'description', 'prompt'] as const

/** Whether an update patch touches any task-content field. */
export function hasContentPatch(patch: TaskUpdatePatch): boolean {
  return (TASK_CONTENT_FIELDS as readonly string[]).some(field => field in patch)
}

/**
 * Whether a task's content may still be edited: the task must be on-board
 * (not archived) and must never have started executing. Fail-closed: a
 * running, settled, or cancelled-before-launch task keeps its content fixed.
 */
export function canEditTaskContent(task: TaskRecord): boolean {
  return task.archivedAt === undefined && task.status !== 'running' && task.executions.length === 0
}

/** Keep an unknown permission string from entering the ledger. */
function normalizePermission(
  current: TaskPermission | undefined,
  value: TaskPermission | undefined,
): TaskPermission | undefined {
  if (value === undefined) return undefined
  return isTaskPermission(value) ? value : current
}

/**
 * Apply an update across the ledger. Tasks that do not match the id are left
 * untouched; the matched task receives the patch plus a fresh updatedAt.
 * @param tasks - current ledger.
 * @param id - the task to update.
 * @param patch - editable-field changes.
 * @param now - clock instant (ms epoch).
 */
export function applyUpdateTask(
  tasks: readonly TaskRecord[],
  id: string,
  patch: TaskUpdatePatch,
  now: number,
): readonly TaskRecord[] {
  return tasks.map(task => {
    if (task.id !== id) return task
    const workspaceId = 'workspaceId' in patch ? normalizeTargetId(patch.workspaceId) : undefined
    const mode = 'mode' in patch ? normalizeTargetId(patch.mode) : undefined
    const model = 'model' in patch
      ? (patch.model === null || patch.model === undefined ? undefined : normalizeModelSelection(patch.model))
      : undefined
    const planModel = 'planModel' in patch
      ? (patch.planModel === null || patch.planModel === undefined ? undefined : normalizeModelSelection(patch.planModel))
      : undefined
    const endpoints = 'endpoints' in patch
      ? (patch.endpoints === null || patch.endpoints === undefined ? undefined : normalizeEndpointList(patch.endpoints))
      : undefined
    const groupId = 'groupId' in patch
      ? (patch.groupId === null || patch.groupId === undefined ? undefined : normalizeTargetId(patch.groupId))
      : undefined
    const permission = 'permission' in patch ? normalizePermission(task.permission, patch.permission) : undefined
    // The patch may carry `model: null`/`planModel: null`/`endpoints: null`/
    // `groupId: null` to clear a pin; the normalized value (or undefined) is
    // written back so the ledger never stores null, and the rest of the patch
    // spreads without it.
    const { model: _patchedModel, planModel: _patchedPlanModel, endpoints: _patchedEndpoints, groupId: _patchedGroupId, ...patchRest } = patch
    const next: TaskRecord = {
      ...task,
      ...patchRest,
      updatedAt: now,
      ...('model' in patch ? { model } : {}),
      ...('planModel' in patch ? { planModel } : {}),
      ...('endpoints' in patch ? { endpoints } : {}),
      ...('groupId' in patch ? { groupId } : {}),
    }
    // Content fields normalize like creation does (trimmed); an explicit
    // undefined keeps the current value — content cannot be cleared.
    for (const field of TASK_CONTENT_FIELDS) {
      if (!(field in patch)) continue
      const value = patch[field]
      next[field] = value === undefined ? task[field] : value.trim()
    }
    if (workspaceId !== undefined || 'workspaceId' in patch) next.workspaceId = workspaceId
    if (mode !== undefined || 'mode' in patch) next.mode = mode
    if (permission !== undefined || 'permission' in patch) next.permission = permission
    return next
  })
}
