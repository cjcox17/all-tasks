/**
 * Task board domain model: task lifecycle statuses, the task record shape,
 * and the pure transition functions the controller and tests share.
 * Framework-free (no cordis, no runtime imports) so the state machine is
 * unit-testable in isolation.
 */
import { normalizeEndpointList } from './endpoints.ts'

/** Task lifecycle status, one per kanban column. */
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'done' | 'failed'

/**
 * Token accounting for one execution, captured from the session's
 * `assistant/message` events at settlement. Counts are DISJOINT: `inputTokens`
 * is uncached input only; cached input is reported separately as
 * `cacheReadTokens`/`cacheWriteTokens`. Absent on runs the adapter reported no
 * usage for (and on runs that settled before usage capture shipped).
 */
export interface ExecutionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Normalize an unknown persisted usage value: a structurally valid usage
 * object with finite non-negative token counts, or undefined. Malformed
 * (non-object, missing, or non-numeric counts) collapses to undefined so a
 * future or damaged ledger never drops the task row over a usage shape.
 */
export function normalizeExecutionUsage(value: unknown): ExecutionUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.inputTokens !== 'number' || !Number.isFinite(record.inputTokens) || record.inputTokens < 0) return undefined
  if (typeof record.outputTokens !== 'number' || !Number.isFinite(record.outputTokens) || record.outputTokens < 0) return undefined
  const optional = (field: string): number | undefined => {
    const candidate = record[field]
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
  }
  const usage: ExecutionUsage = { inputTokens: record.inputTokens, outputTokens: record.outputTokens }
  const cacheReadTokens = optional('cacheReadTokens')
  const cacheWriteTokens = optional('cacheWriteTokens')
  const reasoningTokens = optional('reasoningTokens')
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  return usage
}

/**
 * Why the router holds a run before launch: no eligible endpoint, a group
 * capacity slot (sequential/parallel) is occupied, or the group's allowed
 * window is closed. Absent on launched runs.
 */
export type ExecutionQueuedReason = 'endpoint' | 'group' | 'window' | 'workspace'

/**
 * One real execution attempt: the run's own id, the dsh session that ran it
 * (filled once the session is created), and the settled outcome once the
 * session's turn ended.
 */
export interface ExecutionRecord {
  /** Execution attempt id (uuid). */
  id: string
  /** The dsh session that ran this attempt; absent until creation resolves. */
  sessionId: string | undefined
  /** When the run started (ms epoch). */
  startedAt: number
  /**
   * When the session was actually attached (the real launch instant). For a
   * run that queued for a group slot/endpoint/window, `startedAt` is the
   * request time while `launchedAt` is when the session began — the host
   * monitor scans the session from `launchedAt`, so a shared
   * (maintain-session) sequence never settles a member on an earlier member's
   * turn. Absent on runs that never launched (queued and cancelled).
   */
  launchedAt?: number
  /** When the run settled; absent while still running. */
  endedAt: number | undefined
  /** Outcome once settled. */
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  /** Human failure text when the run failed (prompt rejection or agent error). */
  error: string | undefined
  /**
   * Bounded excerpt of the agent's final answer, captured at settlement for
   * actions and downstream steps. Absent when the run produced no visible text.
   */
  summary?: string
  /**
   * Token accounting captured at settlement (see {@link ExecutionUsage}).
   * Absent when the adapter reported none.
   */
  usage?: ExecutionUsage
  /**
   * When the router queued this run waiting for an eligible endpoint. A queued
   * run has no session yet (nothing billed), keeps the task in 'running', and
   * survives Host restarts (it is not treated as an interrupted start).
   */
  queuedAt?: number
  /**
   * Why the run is being held before launch: the endpoint list has no eligible
   * candidate, a group slot (sequential/parallel capacity) is occupied, the
   * group's allowed window is closed, or the task's workspace is paused.
   * Absent on launched runs.
   */
  queuedReason?: ExecutionQueuedReason
  /**
   * The endpoint this run is routed through: the preferred candidate while
   * queued, the actually chosen endpoint once launched.
   */
  endpointId?: string
  /**
   * When the run was paused (ms epoch): the execution session's active turn
   * was cancelled but the session was kept alive and the execution stays open.
   * While paused the Host never settles the run, launches nothing for it, and
   * holds a queued run; the `continue` action clears the flag and re-prompts
   * the same session so the agent resumes with its history. Absent = running.
   */
  pausedAt?: number
  /**
   * The newest instant from which the Host observes the session (ms epoch).
   * Set when a paused run is continued: the runner ignores every `turn/end`
   * before this boundary (the pause's cancelled turn) and settles only the
   * resumed turn. Absent on runs that were never paused.
   */
  watchFromAt?: number
}

/**
 * Maximum number of execution records retained per task. Older settled runs
 * are trimmed when a new execution starts so per-action ledger cost stays
 * bounded regardless of how often a task ran before.
 */
export const EXECUTION_HISTORY_LIMIT = 20

/**
 * Trim an execution list to at most {@link EXECUTION_HISTORY_LIMIT} records,
 * most recent last. A running (unsettled) execution is never trimmed: the
 * Host monitor and restart recovery depend on the active record, and a task
 * cannot start a new run while one is still open.
 */
export function retainRecentExecutions(executions: readonly ExecutionRecord[]): ExecutionRecord[] {
  if (executions.length <= EXECUTION_HISTORY_LIMIT) return [...executions]
  const open = executions.filter(execution => execution.endedAt === undefined)
  const settled = executions.filter(execution => execution.endedAt !== undefined)
  const keepSettled = Math.max(EXECUTION_HISTORY_LIMIT - open.length, 0)
  return [...settled.slice(Math.max(settled.length - keepSettled, 0)), ...open]
}

/**
 * A scheduled-run rule attached to a task. The Host scheduler triggers the
 * task when `nextRunAt` is due and persists the rule in the Host ledger.
 */
export interface ScheduleRule {
  /** Whether the schedule is armed. */
  enabled: boolean
  /** 5-field cron expression: `分 时 日 月 周`. */
  cron: string
  /** Next due instant (ms epoch); maintained by the scheduler/controller. */
  nextRunAt: number | undefined
  /** Instant of the latest scheduled trigger (ms epoch). */
  lastTriggeredAt: number | undefined
}

/** One task on the board. */
export interface TaskRecord {
  /** Stable task id (uuid). */
  id: string
  /** Short display title. */
  title: string
  /** Longer human description shown in the detail view. */
  description: string
  /** The prompt sent to dsh when this task is executed. */
  prompt: string
  /** Current column. */
  status: TaskStatus
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /**
   * Execution history retained on the task, most recent last: the latest
   * {@link EXECUTION_HISTORY_LIMIT} attempts, oldest trimmed on append.
   */
  executions: ExecutionRecord[]
  /** Optional scheduled-run rule (absent on tasks without a schedule). */
  schedule?: ScheduleRule
  /**
   * Workspace the execution must run in (a workspace-list id); absent means
   * the recent-workspace fallback at execution time.
   */
  workspaceId?: string
  /**
   * Agent preset the execution session must be composed from (an
   * `agentPreset.list` id); absent means the deployment default.
   */
  mode?: string
  /**
   * Permission preset applied to the execution session through the
   * `/permission <id>` slash command; absent leaves the session default.
   */
  permission?: TaskPermission
  /**
   * Model selection the execution session must be pinned to (a provider route
   * + model id); absent means the deployment default model.
   */
  model?: TaskModelSelection
  /**
   * Priority-ordered endpoint ids the router must route this task through
   * (the first eligible endpoint wins; absent means the global default list,
   * and an empty effective list means no routing — the model pin applies
   * directly).
   */
  endpoints?: string[]
  /**
   * The task group this task belongs to (a group id). Membership is one group
   * at most; absent means ungrouped. The group's execution policy (endpoints,
   * sequential/parallel capacity, window, schedule) gates every launch of the
   * member; the group's order drives sequential starts and display order.
   */
  groupId?: string
  /**
   * When the task was archived (ms epoch). Archived tasks keep their status
   * and execution history, leave the main board, and cannot run until restored;
   * absent means on-board.
   */
  archivedAt?: number
  /**
   * Approval gate: an unapproved task (explicit `false`) can never be run by
   * any means — manual runs, reruns, task crons, and group auto-advance are
   * all refused until it is approved. Absent or `true` means approved (the
   * default; only the explicit `false` is persisted, mirroring the group
   * `stopped` flag). Manual board moves and edits stay allowed, so unapproved
   * tasks remain fully manageable.
   */
  approved?: boolean
  /**
   * Auto-advance hold: a member that joined a group whose sequence already
   * started (any current member has an execution, open or settled) is marked
   * held — the group's auto-advance chain skips it until the user explicitly
   * starts it (a manual run, a Start-group, or a group-cron fire all clear
   * the hold). The member stays fully manually startable either way. Absent
   * means the member participates in auto-advance (the default; only the
   * explicit `true` is persisted, mirroring `approved`).
   */
  deferAutoStart?: boolean
}

/**
 * Whether a task may be run: everything except an explicit `false` approval
 * gate. Absent (legacy records) and `true` are both approved.
 */
export function isTaskApproved(task: Pick<TaskRecord, 'approved'>): boolean {
  return task.approved !== false
}

/**
 * Whether a task's group auto-advance is deferred: only the explicit `true`
 * hold (a member that joined a group whose sequence already started). Absent
 * and `false` both mean the member may auto-advance.
 */
export function isTaskAutoStartDeferred(task: Pick<TaskRecord, 'deferAutoStart'>): boolean {
  return task.deferAutoStart === true
}

/** Statuses a settled task may be archived from. */
export const ARCHIVABLE_STATUSES: readonly TaskStatus[] = ['done', 'failed']


/** Permission presets a task may pin on its execution session (the `/permission <id>` ids). */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One permission preset id. */
export type TaskPermission = typeof TASK_PERMISSIONS[number]

/** Whether an unknown value is a known permission preset id. */
export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/**
 * Model selection pinned to a task execution (a DSH provider route + model
 * id, mirroring the `session.selectModel` request). Absent on a task means
 * the deployment default model applies.
 */
export interface TaskModelSelection {
  /** Registered provider route id (for example `deepseek`). */
  provider: string
  /** Provider-owned model id (for example `deepseek-chat`). */
  model: string
  /** Adapter-owned reasoning effort; absence preserves the adapter/provider default. */
  reasoningEffort?: string
}

/** Bound on model/provider/effort id length (defense-in-depth against ledger bloat). */
export const MODEL_FIELD_BOUND = 256

/**
 * Normalize one optional model selection: a non-object, an unknown key, or a
 * blank provider/model collapses to undefined; otherwise a trimmed copy with
 * bounded ids is returned. Shared by ledger parsing, use cases, and pickers.
 */
export function normalizeModelSelection(value: unknown): TaskModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const selection = value as Record<string, unknown>
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  const effort = selection.reasoningEffort
  if (provider === '' || provider.length > MODEL_FIELD_BOUND) return undefined
  if (model === '' || model.length > MODEL_FIELD_BOUND) return undefined
  // A blank effort string is dropped (not a rejection); a non-string or
  // oversized effort rejects the whole selection.
  if (effort !== undefined && typeof effort !== 'string') return undefined
  if (typeof effort === 'string' && effort.length > MODEL_FIELD_BOUND) return undefined
  const trimmedEffort = typeof effort === 'string' ? effort.trim() : undefined
  return {
    provider,
    model,
    ...(trimmedEffort === undefined || trimmedEffort === '' ? {} : { reasoningEffort: trimmedEffort }),
  }
}

/** Select-option key for one model selection (unambiguous JSON, no id-delimiter collisions). */
export function modelSelectionKey(selection: TaskModelSelection): string {
  return JSON.stringify({ provider: selection.provider, model: selection.model })
}

/** Reverse of {@link modelSelectionKey}; undefined when the key is malformed. */
export function parseModelSelectionKey(key: string): TaskModelSelection | undefined {
  try {
    return normalizeModelSelection(JSON.parse(key))
  } catch {
    return undefined
  }
}

/** Input for creating a task. */
export interface NewTaskInput {
  title: string
  description: string
  prompt: string
  /** Workspace the execution must run in; empty/absent = the recent workspace. */
  workspaceId?: string
  /** Agent preset the execution session must be composed from; empty/absent = deployment default. */
  mode?: string
  /** Model selection the execution session must be pinned to; absent = deployment default. */
  model?: TaskModelSelection
  /**
   * Priority-ordered endpoint ids to route this task through (first eligible
   * wins; empty/absent = global default list, and an empty effective list =
   * no routing, direct model pin).
   */
  endpoints?: string[]
  /** Task group to join (a group id); empty/absent = ungrouped. */
  groupId?: string
  /** Permission preset applied to the execution session; absent = session default. */
  permission?: TaskPermission
  /**
   * Optional scheduled-run rule requested at creation time (the new-task
   * dialog): an enable flag plus a 5-field cron expression. The create use
   * case arms it only when enabled and the expression is valid.
   */
  schedule?: { enabled: boolean; cron: string }
  /**
   * Approval state at creation: `false` mints the task unapproved (it cannot
   * run until approved). Absent or `true` (the manual/new-task default) mints
   * it approved. Programmatic creators (the protocol `create` action) may set
   * this; the board's manual dialog never does.
   */
  approved?: boolean
}

/** The five kanban columns, in display order. */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: '待规划' },
  { status: 'todo', label: '待办' },
  { status: 'running', label: '进行中' },
  { status: 'done', label: '已完成' },
  { status: 'failed', label: '已失败' },
]

/** Statuses a user may move a card to manually (execution states are owned by the runner). */
export const MANUAL_STATUSES: readonly TaskStatus[] = ['backlog', 'todo']

/** Statuses the runner may move a card to from 'running'. */
export const RUNNER_SETTLE_STATUSES: readonly TaskStatus[] = ['done', 'failed']

/** All valid statuses (closed union guard). */
export const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'running', 'done', 'failed',
]

/** Brand an unknown string as a status; undefined when it is not one. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/** Whether a manual move target is allowed from the given status. */
export function canMoveManually(from: TaskStatus, to: TaskStatus): boolean {
  return from !== 'running' && (MANUAL_STATUSES as readonly TaskStatus[]).includes(to)
}

/** Normalize one optional execution-target string: trim; blank collapses to undefined. */
export function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Create a task from user input. */
export function createTask(input: NewTaskInput, now: number, id: string): TaskRecord {
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    executions: [],
    workspaceId: normalizeTargetId(input.workspaceId),
    mode: normalizeTargetId(input.mode),
    model: normalizeModelSelection(input.model),
    endpoints: normalizeEndpointList(input.endpoints),
    groupId: normalizeTargetId(input.groupId),
    permission: isTaskPermission(input.permission) ? input.permission : undefined,
    ...(input.approved === false ? { approved: false } : {}),
  }
}

/** Clone a task with an updated status and a fresh updatedAt. */
export function withStatus(task: TaskRecord, status: TaskStatus, now: number): TaskRecord {
  return { ...task, status, updatedAt: now }
}

/**
 * Move one task immediately before another in the ledger array. The ledger
 * array order is the display order for ungrouped cards inside a column, so a
 * drag that lands a card above/below a sibling maps to this transition.
 *
 * `beforeTaskId` is the task the moved task should sit directly above;
 * `undefined` moves it to the end of the array. The transition is a no-op
 * when the task is already in place (already directly above the target, or
 * already at the end). Unknown ids leave the array untouched.
 */
export function moveTaskBefore(
  tasks: readonly TaskRecord[],
  taskId: string,
  beforeTaskId: string | undefined,
): readonly TaskRecord[] {
  const from = tasks.findIndex(task => task.id === taskId)
  if (from === -1) return tasks
  if (beforeTaskId === undefined) {
    if (from === tasks.length - 1) return tasks
    return [...tasks.slice(0, from), ...tasks.slice(from + 1), tasks[from]!]
  }
  const to = tasks.findIndex(task => task.id === beforeTaskId)
  if (to === -1 || to === from) return tasks
  // The insertion index is the target's index; removing the dragged task
  // shifts any target after it left by one.
  const insertAt = to > from ? to - 1 : to
  if (insertAt === from) return tasks
  const rest = tasks.filter(task => task.id !== taskId)
  return [...rest.slice(0, insertAt), tasks[from]!, ...rest.slice(insertAt)]
}

/**
 * Merge a schedule patch into a task's schedule rule (creating it when
 * absent), with a fresh updatedAt. Keys present in the patch overwrite the
 * current value — including explicit `undefined`, which clears a field (used
 * to disarm `nextRunAt`); absent keys keep their current value.
 */
export function withSchedule(
  task: TaskRecord,
  patch: Partial<ScheduleRule>,
  now: number,
): TaskRecord {
  const current = task.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  return { ...task, updatedAt: now, schedule }
}

/**
 * Open a fresh execution on a task: move it to 'running' and append a
 * running execution record. Returns the new task and the new execution.
 */
export function startExecution(
  task: TaskRecord,
  now: number,
  executionId: string,
): { task: TaskRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    sessionId: undefined,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
  }
  return {
    task: {
      ...task,
      status: 'running',
      updatedAt: now,
      executions: retainRecentExecutions([...task.executions, execution]),
    },
    execution,
  }
}

/**
 * Settle a running execution: record the outcome and move the task into the
 * matching column. No-op (returns the input task) when the execution is not
 * the task's latest or is already settled.
 *
 * A cancelled outcome lands in the failed column (a stop/cancel is a
 * non-success: the run did not complete), never back in todo.
 */
export function settleExecution(
  task: TaskRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  now: number,
  error: string | undefined,
  summary?: string,
  usage?: ExecutionUsage,
): TaskRecord {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return task
  const execution = task.executions[index]
  if (execution.endedAt !== undefined) return task
  const settled: ExecutionRecord = {
    ...execution,
    endedAt: now,
    result: outcome,
    error,
    ...(summary === undefined ? {} : { summary }),
    ...(usage === undefined ? {} : { usage }),
  }
  const executions = [...task.executions]
  executions[index] = settled
  const status: TaskStatus = outcome === 'succeeded' ? 'done' : 'failed'
  return { ...task, status, updatedAt: now, executions }
}

/** A settled-execution summary string for the detail view. */
export function executionLabel(execution: ExecutionRecord): string {
  if (execution.result === 'succeeded') return 'succeeded'
  if (execution.result === 'failed') return 'failed'
  if (execution.result === 'cancelled') return 'cancelled'
  return 'running'
}

/** The open (unsettled) execution of a task, if any — running, queued, or paused. */
export function openExecutionOf(task: TaskRecord): ExecutionRecord | undefined {
  return task.executions.find(execution => execution.endedAt === undefined)
}

/** Whether the task's open execution is paused (halted but resumable). */
export function isTaskPaused(task: TaskRecord): boolean {
  return openExecutionOf(task)?.pausedAt !== undefined
}

/**
 * Pause an open execution: keep the run open, record the pause instant, and
 * leave the session alive so `continue` can re-prompt it later. Returns the
 * updated task, or undefined when the execution is not open or already paused.
 */
export function pauseExecution(
  task: TaskRecord,
  executionId: string,
  now: number,
): TaskRecord | undefined {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return undefined
  const execution = task.executions[index]
  if (execution.endedAt !== undefined || execution.pausedAt !== undefined) return undefined
  const executions = [...task.executions]
  executions[index] = { ...execution, pausedAt: now }
  return { ...task, updatedAt: now, executions }
}

/**
 * Continue a paused execution: clear the pause and advance the observation
 * boundary past the pause's cancelled turn, so the runner settles only the
 * resumed turn. Returns the updated task, or undefined when the execution is
 * not open or not paused.
 */
export function continueExecution(
  task: TaskRecord,
  executionId: string,
  now: number,
): TaskRecord | undefined {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return undefined
  const execution = task.executions[index]
  if (execution.endedAt !== undefined || execution.pausedAt === undefined) return undefined
  const { pausedAt: _paused, ...rest } = execution
  const executions = [...task.executions]
  executions[index] = { ...rest, watchFromAt: now }
  return { ...task, updatedAt: now, executions }
}
