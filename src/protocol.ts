import type { TaskUpdatePatch } from './core/use-cases/task-update.ts'
import { normalizeDailyWindow, normalizeEndpointList } from './core/endpoints.ts'
import {
  GROUP_FIELD_BOUND,
  GROUP_MAX_PARALLEL_BOUND,
  GROUP_ORDER_BOUND,
  isGroupExecutionMode,
  normalizeMaxParallel,
  type GroupCreateInput,
  type GroupUpdatePatch,
  type TaskGroupRecord,
} from './core/groups.ts'
import { isTaskPermission, isTaskStatus, MODEL_FIELD_BOUND, normalizeModelSelection, type NewTaskInput, type TaskModelSelection, type TaskRecord, type TaskStatus } from './core/tasks.ts'
import { parseLedger } from './core/store.ts'
import { normalizeWorkspaceDefaultsPatch, type WorkspaceDefaultsPatch, type WorkspaceDefaultsRecord } from './core/workspace-defaults.ts'

export const TASK_BOARD_SCHEMA_VERSION = 2 as const
export const TASK_BOARD_API_PREFIX = '/api/task-board'

export type PowerPhase = 'disabled' | 'idle' | 'acquiring' | 'active' | 'error' | 'unsupported'

export interface TaskBoardPowerSnapshot {
  platform: string
  phase: PowerPhase
  enabled: boolean
  runningSessions: number
  armedSchedules: number
  sessionStateKnown: boolean
  lastError?: string
}

export interface TaskBoardSchedulerSnapshot {
  timeZone: string
  /** Opaque identity of the current Host ledger generation. */
  ledgerId?: string
  lastTickAt?: number
  error?: string
}

export interface TaskBoardSnapshot {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  /** Task groups (named member sets with shared execution policy). */
  groups: TaskGroupRecord[]
  /**
   * Per-workspace execution defaults the new-task dialog applies when a task
   * is created in that workspace, keyed by workspace-list id.
   */
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>
  scheduler: TaskBoardSchedulerSnapshot
  power: TaskBoardPowerSnapshot
}

/** SSE event frame: revision/scheduler/power only, never the task list. */
export interface TaskBoardEventPayload {
  revision: number
  scheduler: TaskBoardSchedulerSnapshot
  power: TaskBoardPowerSnapshot
}

export type TaskBoardAction =
  | { kind: 'import'; sourceId: string; tasks: TaskRecord[] }
  | { kind: 'create'; id: string; input: NewTaskInput }
  | { kind: 'update'; taskId: string; patch: TaskUpdatePatch }
  | { kind: 'delete'; taskId: string }
  | { kind: 'move'; taskId: string; status: TaskStatus }
  | {
    kind: 'reorder'
    taskId: string
    /**
     * The task the moved task should sit directly above in the ledger array
     * (the ungrouped display order); `null` moves it to the end of the array.
     */
    beforeTaskId: string | null
  }
  | { kind: 'archive'; taskId: string }
  | { kind: 'restore'; taskId: string }
  | { kind: 'set-schedule'; taskId: string; patch: { enabled?: boolean; cron?: string } }
  | { kind: 'run'; taskId: string }
  | { kind: 'rerun'; taskId: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'set-approved'; taskId: string; approved: boolean }
  | { kind: 'set-workspace-defaults'; workspaceId: string; patch: WorkspaceDefaultsPatch }
  | { kind: 'create-group'; id: string; input: GroupCreateInput }
  | { kind: 'update-group'; groupId: string; patch: GroupUpdatePatch }
  | { kind: 'delete-group'; groupId: string }
  | { kind: 'set-group-order'; groupId: string; order: string[] }
  | { kind: 'stop-group'; groupId: string }
  | { kind: 'run-group'; groupId: string }
  | { kind: 'move-group'; groupId: string; status: TaskStatus }

export interface TaskBoardActionEnvelope {
  requestId: string
  action: TaskBoardAction
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/**
 * Gate a model selection from the wire: exact keys, non-blank bounded
 * provider/model strings, and an optional bounded reasoning effort. Returns
 * the normalized selection (trimmed ids), or undefined when rejected.
 */
function modelPayload(value: unknown): TaskModelSelection | undefined {
  const selection = record(value)
  if (selection === undefined || !exactKeys(selection, ['provider', 'model', 'reasoningEffort'])) return undefined
  const provider = selection.provider
  const model = selection.model
  const effort = selection.reasoningEffort
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > MODEL_FIELD_BOUND) return undefined
  if (typeof model !== 'string' || model.trim() === '' || model.length > MODEL_FIELD_BOUND) return undefined
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '' || effort.length > MODEL_FIELD_BOUND)) return undefined
  return normalizeModelSelection(selection)
}

const FORBIDDEN_IMPORT_FIELDS = new Set(['args', 'command', 'executable', 'powershell', 'shell'])

function hasForbiddenImportField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenImportField)
  const row = record(value)
  if (row === undefined) return false
  return Object.entries(row).some(([key, nested]) => FORBIDDEN_IMPORT_FIELDS.has(key.toLowerCase()) || hasForbiddenImportField(nested))
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function validImportedKnownFields(value: Record<string, unknown>): boolean {
  if (value.schedule !== undefined) {
    const schedule = record(value.schedule)
    if (schedule === undefined || typeof schedule.enabled !== 'boolean' || typeof schedule.cron !== 'string') return false
    if (!optionalFiniteNumber(schedule.nextRunAt) || !optionalFiniteNumber(schedule.lastTriggeredAt)) return false
  }
  if (value.executions !== undefined) {
    if (!Array.isArray(value.executions)) return false
    for (const item of value.executions) {
      const execution = record(item)
      if (execution === undefined || typeof execution.id !== 'string' || !optionalString(execution.sessionId)) return false
      if (typeof execution.startedAt !== 'number' || !Number.isFinite(execution.startedAt)) return false
      if (!optionalFiniteNumber(execution.endedAt) || !optionalString(execution.error)) return false
      if (execution.result !== undefined && !['succeeded', 'failed', 'cancelled'].includes(String(execution.result))) return false
    }
  }
  return true
}

function importedTask(value: unknown): TaskRecord | undefined {
  const input = record(value)
  if (input === undefined || hasForbiddenImportField(input) || !validImportedKnownFields(input)) return undefined
  const task = parseLedger(JSON.stringify([value]))[0]
  if (task === undefined) return undefined
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    executions: task.executions.map(execution => ({
      id: execution.id,
      sessionId: execution.sessionId,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      result: execution.result,
      error: execution.error,
    })),
    ...(task.schedule === undefined ? {} : {
      schedule: {
        enabled: task.schedule.enabled,
        cron: task.schedule.cron,
        nextRunAt: task.schedule.nextRunAt,
        lastTriggeredAt: task.schedule.lastTriggeredAt,
      },
    }),
    ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    ...(task.permission === undefined ? {} : { permission: task.permission }),
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.endpoints === undefined ? {} : { endpoints: task.endpoints }),
    ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
    ...(task.approved === false ? { approved: false } : {}),
  }
}

function createInput(value: unknown): value is NewTaskInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'model', 'endpoints', 'groupId', 'permission', 'schedule', 'approved'])) return false
  if (typeof input.title !== 'string' || typeof input.description !== 'string' || typeof input.prompt !== 'string') return false
  if (!optionalString(input.workspaceId) || !optionalString(input.mode)) return false
  if (input.approved !== undefined && typeof input.approved !== 'boolean') return false
  if (input.model !== undefined && modelPayload(input.model) === undefined) return false
  // A malformed endpoint list (non-array, oversized, or non-string entries)
  // rejects the whole create instead of silently dropping the pin; an empty
  // array is fine (it normalizes to no pin).
  if (input.endpoints !== undefined
    && !Array.isArray(input.endpoints)
    && normalizeEndpointList(input.endpoints) === undefined) return false
  if (input.groupId !== undefined && !boundedId(input.groupId)) return false
  if (input.permission !== undefined && !isTaskPermission(input.permission)) return false
  if (input.schedule !== undefined) {
    const schedule = record(input.schedule)
    if (schedule === undefined || !exactKeys(schedule, ['enabled', 'cron'])) return false
    if (typeof schedule.enabled !== 'boolean' || typeof schedule.cron !== 'string') return false
  }
  return true
}

function updatePatch(value: unknown): boolean {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'model', 'endpoints', 'groupId', 'permission'])) return false
  for (const key of ['title', 'description', 'prompt', 'workspaceId', 'mode'] as const) {
    if (!optionalString(patch[key])) return false
  }
  // null clears the model pin; an object must pass the model gate.
  if (patch.model !== undefined && patch.model !== null && modelPayload(patch.model) === undefined) return false
  // null (or an empty array) clears the endpoint pin; a non-empty array must
  // normalize.
  if (patch.endpoints !== undefined
    && patch.endpoints !== null
    && !Array.isArray(patch.endpoints)
    && normalizeEndpointList(patch.endpoints) === undefined) return false
  // null clears the group membership; a string must be a bounded id.
  if (patch.groupId !== undefined && patch.groupId !== null && !boundedId(patch.groupId)) return false
  return patch.permission === undefined || isTaskPermission(patch.permission)
}

function schedulePatch(value: unknown): boolean {
  const patch = record(value)
  return patch !== undefined
    && exactKeys(patch, ['enabled', 'cron'])
    && (patch.enabled === undefined || typeof patch.enabled === 'boolean')
    && (patch.cron === undefined || typeof patch.cron === 'string')
}

/** A non-blank bounded id (group ids and group-member references). */
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= GROUP_FIELD_BOUND
}

/** Gate one group create/update schedule field (a task-style schedule patch). */
function groupScheduleField(value: unknown): boolean {
  return schedulePatch(value)
}

/** Gate a group create input. */
function groupInput(value: unknown): value is GroupCreateInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['name', 'mode', 'maxParallel', 'endpoints', 'allowedHours', 'offPeakOnly', 'schedule'])) return false
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > GROUP_FIELD_BOUND) return false
  if (input.mode !== undefined && !isGroupExecutionMode(input.mode)) return false
  if (input.maxParallel !== undefined && normalizeMaxParallel(input.maxParallel) === undefined) return false
  if (input.endpoints !== undefined && !Array.isArray(input.endpoints) && normalizeEndpointList(input.endpoints) === undefined) return false
  if (input.allowedHours !== undefined && normalizeDailyWindow(input.allowedHours) === undefined) return false
  if (input.offPeakOnly !== undefined && typeof input.offPeakOnly !== 'boolean') return false
  if (input.schedule !== undefined && !groupScheduleField(input.schedule)) return false
  return true
}

/** Gate a group update patch (every field optional; null clears a field). */
function groupUpdatePatch(value: unknown): value is GroupUpdatePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['name', 'mode', 'maxParallel', 'endpoints', 'allowedHours', 'offPeakOnly', 'stopped', 'schedule'])) return false
  if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.trim() === '' || patch.name.length > GROUP_FIELD_BOUND)) return false
  if (patch.mode !== undefined && !isGroupExecutionMode(patch.mode)) return false
  if (patch.maxParallel !== undefined && patch.maxParallel !== null && normalizeMaxParallel(patch.maxParallel) === undefined) return false
  if (patch.endpoints !== undefined && patch.endpoints !== null && !Array.isArray(patch.endpoints) && normalizeEndpointList(patch.endpoints) === undefined) return false
  if (patch.allowedHours !== undefined && patch.allowedHours !== null && normalizeDailyWindow(patch.allowedHours) === undefined) return false
  if (patch.offPeakOnly !== undefined && typeof patch.offPeakOnly !== 'boolean') return false
  if (patch.stopped !== undefined && typeof patch.stopped !== 'boolean') return false
  if (patch.schedule !== undefined && patch.schedule !== null && !groupScheduleField(patch.schedule)) return false
  return true
}

/** Gate a set-group-order payload: bounded ids, capped length (membership checked Host-side). */
function groupOrderPayload(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > GROUP_ORDER_BOUND) return false
  return value.every(id => boundedId(id))
}

/** Sanitize the optional fields of a group create/update payload (mirror of the create/update task sanitizer). */
function sanitizeGroupPatch(patch: GroupUpdatePatch | GroupCreateInput): GroupUpdatePatch | GroupCreateInput {
  const sanitized: GroupUpdatePatch | GroupCreateInput = { ...patch }
  if ('maxParallel' in sanitized && sanitized.maxParallel !== undefined && sanitized.maxParallel !== null) {
    sanitized.maxParallel = normalizeMaxParallel(sanitized.maxParallel)
  }
  if ('endpoints' in sanitized && sanitized.endpoints !== undefined && sanitized.endpoints !== null) {
    sanitized.endpoints = normalizeEndpointList(sanitized.endpoints)
  }
  if ('allowedHours' in sanitized && sanitized.allowedHours !== undefined && sanitized.allowedHours !== null) {
    sanitized.allowedHours = normalizeDailyWindow(sanitized.allowedHours)
  }
  return sanitized
}

export function parseActionEnvelope(value: unknown): TaskBoardActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const taskId = typeof action.taskId === 'string' && action.taskId !== '' ? action.taskId : undefined
  switch (action.kind) {
    case 'import':
      if (!exactKeys(action, ['kind', 'sourceId', 'tasks'])) return undefined
      if (typeof action.sourceId !== 'string' || action.sourceId === '' || !Array.isArray(action.tasks)) return undefined
      {
        const tasks = action.tasks.map(importedTask)
        return tasks.every((task): task is TaskRecord => task !== undefined)
          ? { requestId: envelope.requestId, action: { kind: 'import', sourceId: action.sourceId, tasks } }
          : undefined
      }
    case 'create':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      if (typeof action.id !== 'string' || action.id === '' || !createInput(action.input)) return undefined
      {
        const input = action.input as NewTaskInput
        const model = input.model === undefined ? undefined : modelPayload(input.model)
        const endpoints = input.endpoints === undefined ? undefined : normalizeEndpointList(input.endpoints)
        const groupId = input.groupId === undefined ? undefined : input.groupId.trim()
        const sanitized = model === input.model && endpoints === input.endpoints && groupId === input.groupId
          ? input
          : { ...input, model, endpoints, groupId }
        return { requestId: envelope.requestId, action: { kind: 'create', id: action.id, input: sanitized } }
      }
    case 'update':
      if (!exactKeys(action, ['kind', 'taskId', 'patch'])) return undefined
      if (taskId === undefined || !updatePatch(action.patch)) return undefined
      {
        const patch = action.patch as TaskUpdatePatch
        const model = patch.model === undefined || patch.model === null ? patch.model : modelPayload(patch.model)
        const endpoints = patch.endpoints === undefined || patch.endpoints === null ? patch.endpoints : normalizeEndpointList(patch.endpoints)
        const groupId = patch.groupId === undefined || patch.groupId === null ? patch.groupId : patch.groupId.trim()
        const sanitized = model === patch.model && endpoints === patch.endpoints && groupId === patch.groupId
          ? patch
          : { ...patch, model, endpoints, groupId }
        return { requestId: envelope.requestId, action: { kind: 'update', taskId, patch: sanitized } }
      }
    case 'create-group':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      if (typeof action.id !== 'string' || action.id === '') return undefined
      if (!groupInput(action.input)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'create-group', id: action.id, input: sanitizeGroupPatch(action.input) as GroupCreateInput } }
    case 'update-group':
      if (!exactKeys(action, ['kind', 'groupId', 'patch'])) return undefined
      if (typeof action.groupId !== 'string' || action.groupId === '') return undefined
      if (!groupUpdatePatch(action.patch)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'update-group', groupId: action.groupId, patch: sanitizeGroupPatch(action.patch) as GroupUpdatePatch } }
    case 'delete-group':
      if (!exactKeys(action, ['kind', 'groupId'])) return undefined
      return typeof action.groupId === 'string' && action.groupId !== ''
        ? { requestId: envelope.requestId, action: { kind: 'delete-group', groupId: action.groupId } }
        : undefined
    case 'set-group-order':
      if (!exactKeys(action, ['kind', 'groupId', 'order'])) return undefined
      return typeof action.groupId === 'string' && action.groupId !== '' && groupOrderPayload(action.order)
        ? { requestId: envelope.requestId, action: { kind: 'set-group-order', groupId: action.groupId, order: action.order } }
        : undefined
    case 'stop':
      if (!exactKeys(action, ['kind', 'taskId'])) return undefined
      return taskId === undefined ? undefined : { requestId: envelope.requestId, action: { kind: 'stop', taskId } }
    case 'set-approved':
      if (!exactKeys(action, ['kind', 'taskId', 'approved'])) return undefined
      return taskId !== undefined && typeof action.approved === 'boolean'
        ? { requestId: envelope.requestId, action: { kind: 'set-approved', taskId, approved: action.approved } }
        : undefined
    case 'set-workspace-defaults':
      if (!exactKeys(action, ['kind', 'workspaceId', 'patch'])) return undefined
      if (!boundedId(action.workspaceId)) return undefined
      {
        const patch = normalizeWorkspaceDefaultsPatch(action.patch)
        if (patch === undefined) return undefined
        return { requestId: envelope.requestId, action: { kind: 'set-workspace-defaults', workspaceId: action.workspaceId, patch } }
      }
    case 'stop-group':
      if (!exactKeys(action, ['kind', 'groupId'])) return undefined
      return typeof action.groupId === 'string' && action.groupId !== ''
        ? { requestId: envelope.requestId, action: { kind: 'stop-group', groupId: action.groupId } }
        : undefined
    case 'run-group':
      if (!exactKeys(action, ['kind', 'groupId'])) return undefined
      return typeof action.groupId === 'string' && action.groupId !== ''
        ? { requestId: envelope.requestId, action: { kind: 'run-group', groupId: action.groupId } }
        : undefined
    case 'move-group':
      if (!exactKeys(action, ['kind', 'groupId', 'status'])) return undefined
      return typeof action.groupId === 'string' && action.groupId !== '' && isTaskStatus(action.status)
        ? { requestId: envelope.requestId, action: { kind: 'move-group', groupId: action.groupId, status: action.status } }
        : undefined
    case 'set-schedule':
      if (!exactKeys(action, ['kind', 'taskId', 'patch'])) return undefined
      return taskId !== undefined && schedulePatch(action.patch)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'set-schedule' }> }
        : undefined
    case 'move':
      if (!exactKeys(action, ['kind', 'taskId', 'status'])) return undefined
      return taskId !== undefined && isTaskStatus(action.status)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'move' }> }
        : undefined
    case 'reorder':
      if (!exactKeys(action, ['kind', 'taskId', 'beforeTaskId'])) return undefined
      return taskId !== undefined && (action.beforeTaskId === null || boundedId(action.beforeTaskId))
        ? { requestId: envelope.requestId, action: { kind: 'reorder', taskId, beforeTaskId: action.beforeTaskId } }
        : undefined
    case 'delete':
    case 'archive':
    case 'restore':
    case 'run':
    case 'rerun':
      if (!exactKeys(action, ['kind', 'taskId'])) return undefined
      return taskId === undefined ? undefined : { requestId: envelope.requestId, action: action as TaskBoardAction }
    default:
      return undefined
  }
}
