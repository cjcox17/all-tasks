/**
 * Task-groups core: the group record shape, normalization, membership/order
 * transitions, and the pure execution-policy helpers the Host router uses
 * (capacity, window, sequential advance). Framework-free (no cordis, no
 * runtime imports) so the Host router and unit tests share one engine.
 *
 * A group is a named set of tasks with shared execution policy:
 *  - workspaceId: the workspace scope the group belongs to. A group scoped to
 *    a workspace accepts only tasks pinned to that workspace as members; a
 *    group without a scope accepts only unassigned tasks. Membership is
 *    enforced Host-side (a task may join a group only when its own workspace
 *    pin equals the group's scope), so the same group name can exist in many
 *    workspaces with different settings;
 *  - endpoints: priority-ordered endpoint ids (task pin > group list > global
 *    default list);
 *  - mode: sequential (one member runs at a time, in group order) or parallel
 *    (up to maxParallel at once, blank = unlimited);
 *  - allowedHours / offPeakOnly: a daily window gate all member launches must
 *    pass;
 *  - schedule: an optional group cron. When enabled, members inherit it (their
 *    own cron is ignored) and the cron starts the sequence.
 *
 * Every launch of a member (manual run, cron, router auto-start) respects the
 * group's capacity and window; blocked manual runs queue and auto-start when a
 * slot or window frees, mirroring the endpoint queue.
 */
import {
  inDailyWindow,
  isOffPeakNow,
  normalizeDailyWindow,
  normalizeEndpointList,
  type DailyWindow,
} from './endpoints.ts'
import { isValidCron, nextRunAtMs } from './schedule.ts'
import { normalizeTargetId, type ExecutionQueuedReason, type TaskRecord } from './tasks.ts'
export type { ExecutionQueuedReason } from './tasks.ts'

/** Bound on group name / task-id string length (defense-in-depth). */
export const GROUP_FIELD_BOUND = 256
/** Bound on how many members a group order may list. */
export const GROUP_ORDER_BOUND = 512
/** Upper bound on a parallel group's maxParallel value. */
export const GROUP_MAX_PARALLEL_BOUND = 1024

/** How a group schedules its members. */
export type GroupExecutionMode = 'sequential' | 'parallel'

/** The two valid execution modes (closed union guard). */
export const GROUP_EXECUTION_MODES: readonly GroupExecutionMode[] = ['sequential', 'parallel']

/** Brand an unknown value as an execution mode. */
export function isGroupExecutionMode(value: unknown): value is GroupExecutionMode {
  return typeof value === 'string' && (GROUP_EXECUTION_MODES as readonly string[]).includes(value)
}

/** A group's cron rule (same grammar and semantics as a task schedule). */
export interface GroupScheduleRule {
  enabled: boolean
  cron: string
  nextRunAt?: number
  lastTriggeredAt?: number
}

/** One task group on the board. */
export interface TaskGroupRecord {
  /** Stable group id (uuid). */
  id: string
  /**
   * Display name shown on the board banners. Names are NOT unique: the same
   * name may exist in every workspace with different settings.
   */
  name: string
  /**
   * The workspace scope this group belongs to (a workspace-list id). A task
   * may join the group only when its own `workspaceId` equals this value;
   * absent means the unassigned scope (only tasks without a workspace pin can
   * be members). Never editable through update-group — a group lives and dies
   * in the workspace it was created from.
   */
  workspaceId?: string
  /** How members run: one at a time (in order) or up to maxParallel at once. */
  mode: GroupExecutionMode
  /** Parallel cap; absent (parallel mode) means unlimited. */
  maxParallel?: number
  /**
   * Priority-ordered endpoint ids the router routes members through (the
   * first eligible endpoint wins; a member's own endpoint pin overrides the
   * group list, and an empty effective list falls back to the global default).
   */
  endpoints?: string[]
  /** Daily hours (host-local) member launches must fall inside; absent = always. */
  allowedHours?: DailyWindow
  /** Only launch members inside the global off-peak window. */
  offPeakOnly: boolean
  /**
   * Whether the group is stopped: no member may launch (auto-advance, manual
   * runs, and crons are refused) until the group is resumed. Set by the
   * stop-group action, which also cancels every open member execution.
   */
  stopped?: boolean
  /**
   * Whether the group is paused: every open member execution is halted (kept
   * alive and resumable) and no member may launch until the group is
   * continued. Set by the pause-group action, which pauses each member's
   * session without settling it; continue-group re-prompts the paused members
   * and clears the flag. A stopped group launches nothing either way, but stop
   * settles members as cancelled while pause keeps them open.
   */
  paused?: boolean
  /**
   * Sequential only: reuse the same DSH session for every member instead of
   * creating a fresh session per task. The first launched member creates the
   * session (its workspace/preset compose it); every later member reuses that
   * session, so the conversation context carries across tasks. Members must
   * share the same effective workspace and agent preset — a member pinned to
   * a different one fails closed before its prompt.
   */
  maintainSession?: boolean
  /**
   * Sequential only (with `maintainSession`): run `/compact` on the shared
   * session before each member's prompt, summarizing the accumulated context
   * into a checkpoint while keeping its key content — so a long group stays
   * within the context window without losing the conversation.
   */
  compactBetween?: boolean
  /**
   * Optional group final step: the id of the member task that runs only after
   * every other member has settled — the fan-in / merge step of a parallel
   * group. The final step is excluded from the parallel burst and from
   * auto-advance until the gate opens ({@link groupFinalStepReady}); it then
   * launches once per cycle (the advance pass starts it, or an explicit
   * run-group / manual run / group cron once the members are settled).
   */
  finalStepTaskId?: string
  /**
   * Only meaningful with `finalStepTaskId`: when true, the final step waits
   * until every other member is in the done column (any failure blocks it);
   * when false (the default), any settled outcome (done or failed) opens the
   * gate. Archived members never block either way.
   */
  finalStepRequireSuccess?: boolean
  /** Optional group cron; when enabled members inherit it (their cron is ignored). */
  schedule?: GroupScheduleRule
  /** Member task ids in manual order (drives sequential starts and display). */
  order: string[]
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
}

/** Input for creating a group. */
export interface GroupCreateInput {
  name: string
  /**
   * Workspace scope the group belongs to; absent = the unassigned scope
   * (only tasks without a workspace pin can be members). Fixed at creation.
   */
  workspaceId?: string
  /** Execution mode; defaults to 'sequential'. */
  mode?: GroupExecutionMode
  /** Parallel cap; absent = unlimited (parallel mode). */
  maxParallel?: number
  /** Priority-ordered endpoint ids for member routing. */
  endpoints?: string[]
  /** Daily hours (host-local) member launches must fall inside. */
  allowedHours?: DailyWindow
  /** Only launch members inside the global off-peak window. */
  offPeakOnly?: boolean
  /** Sequential only: reuse one DSH session for every member (context continuity). */
  maintainSession?: boolean
  /** Sequential only (with maintainSession): run /compact on the shared session between members. */
  compactBetween?: boolean
  /** Optional cron requested at creation; armed only when enabled and valid. */
  schedule?: { enabled: boolean; cron: string }
}

/** Normalize a group name: non-blank, bounded; undefined when invalid. */
export function normalizeGroupName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > GROUP_FIELD_BOUND) return undefined
  return trimmed
}

/** Normalize a maxParallel value: integer in [1, bound]; undefined when invalid. */
export function normalizeMaxParallel(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 1 || value > GROUP_MAX_PARALLEL_BOUND) return undefined
  return value
}

/**
 * Normalize a group's ordered member list against the actual member ids:
 * listed ids first (valid, deduplicated, bounded), then any member not listed
 * appended in member-id order — so the order always covers exactly the members
 * even when a caller sends a stale partial list.
 */
export function normalizeGroupOrder(value: unknown, memberIds: readonly string[]): string[] {
  const memberSet = new Set(memberIds)
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (!memberSet.has(id) || seen.has(id)) return
    seen.add(id)
    ordered.push(id)
    if (ordered.length >= GROUP_ORDER_BOUND) return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      push(item)
      if (ordered.length >= GROUP_ORDER_BOUND) return ordered
    }
  }
  for (const id of memberIds) {
    push(id)
    if (ordered.length >= GROUP_ORDER_BOUND) return ordered
  }
  return ordered
}

/** Build a group schedule rule from a creation request (armed only when valid). */
function groupScheduleFromRequest(requested: { enabled: boolean; cron: string } | undefined, now: number): GroupScheduleRule | undefined {
  if (requested === undefined || requested.enabled !== true) return undefined
  const cron = requested.cron.trim()
  if (cron === '' || !isValidCron(cron)) return undefined
  return { enabled: true, cron, nextRunAt: nextRunAtMs(cron, now) }
}

/**
 * Whether a task may be a member of a group: the task's workspace pin must
 * equal the group's workspace scope. Both absent (an unassigned task and an
 * unassigned-scope group) match; a pinned task can never join an
 * unassigned-scope group and vice versa. The Host enforces this at every
 * membership transition; the UI mirrors it so mismatched joins are never
 * offered in the first place.
 */
export function taskMatchesGroupScope(task: { workspaceId?: string }, group: { workspaceId?: string }): boolean {
  return task.workspaceId === group.workspaceId
}

/** Create a group from user input; undefined when the name is blank. */
export function createGroup(input: GroupCreateInput, now: number, id: string): TaskGroupRecord | undefined {
  const name = normalizeGroupName(input.name)
  if (name === undefined) return undefined
  const mode = input.mode !== undefined && isGroupExecutionMode(input.mode) ? input.mode : 'sequential'
  const maxParallel = input.maxParallel === undefined ? undefined : normalizeMaxParallel(input.maxParallel)
  const endpoints = input.endpoints === undefined ? undefined : normalizeEndpointList(input.endpoints)
  const allowedHours = input.allowedHours === undefined ? undefined : normalizeDailyWindow(input.allowedHours)
  const schedule = groupScheduleFromRequest(input.schedule, now)
  const workspaceId = input.workspaceId === undefined ? undefined : normalizeTargetId(input.workspaceId)
  return {
    id,
    name,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    mode,
    ...(maxParallel === undefined ? {} : { maxParallel }),
    ...(endpoints === undefined ? {} : { endpoints }),
    ...(allowedHours === undefined ? {} : { allowedHours }),
    offPeakOnly: input.offPeakOnly === true,
    ...(input.maintainSession === true ? { maintainSession: true } : {}),
    ...(input.compactBetween === true ? { compactBetween: true } : {}),
    ...(schedule === undefined ? {} : { schedule }),
    order: [],
    createdAt: now,
    updatedAt: now,
  }
}/** Result of a create transition: the new group (when accepted) + the next list. */
export interface CreateGroupResult {
  group: TaskGroupRecord | undefined
  groups: readonly TaskGroupRecord[]
}

/** Apply a create against the current group list. */
export function applyCreateGroup(
  groups: readonly TaskGroupRecord[],
  input: GroupCreateInput,
  now: number,
  id: string,
): CreateGroupResult {
  const group = createGroup(input, now, id)
  if (group === undefined) return { group: undefined, groups }
  return { group, groups: [...groups, group] }
}

/** Replace a group's member order with the given ids (normalized against the members). */
export function withGroupOrder(
  groups: readonly TaskGroupRecord[],
  groupId: string,
  order: readonly string[],
  memberIds: readonly string[],
  now: number,
): TaskGroupRecord[] {
  const next = normalizeGroupOrder(order, memberIds)
  return groups.map(group => group.id !== groupId ? group : { ...group, order: next, updatedAt: now })
}

/** Append a task id to a group's member order (idempotent). */
export function withMemberAssigned(
  groups: readonly TaskGroupRecord[],
  groupId: string,
  taskId: string,
  now: number,
): TaskGroupRecord[] {
  return groups.map(group => group.id !== groupId || group.order.includes(taskId)
    ? group
    : { ...group, order: [...group.order, taskId], updatedAt: now })
}

/** Remove a task id from a group's member order (idempotent). */
export function withMemberRemoved(
  groups: readonly TaskGroupRecord[],
  groupId: string,
  taskId: string,
  now: number,
): TaskGroupRecord[] {
  return groups.map(group => {
    if (group.id !== groupId || !group.order.includes(taskId)) return group
    const next: TaskGroupRecord = { ...group, order: group.order.filter(id => id !== taskId), updatedAt: now }
    // The group's final step must be a member; removing the designated member
    // clears the designation (the fan-in step cannot outlive its task).
    if (next.finalStepTaskId === taskId) delete next.finalStepTaskId
    return next
  })
}

/**
 * Apply one membership change across the group list: the task leaves its
 * previous group's order (when any) and joins the next group's order (when any).
 */
export function withGroupMembershipChange(
  groups: readonly TaskGroupRecord[],
  taskId: string,
  previousGroupId: string | undefined,
  nextGroupId: string | undefined,
  now: number,
): TaskGroupRecord[] {
  let next: TaskGroupRecord[] = [...groups]
  if (previousGroupId !== undefined) next = withMemberRemoved(next, previousGroupId, taskId, now)
  if (nextGroupId !== undefined) next = withMemberAssigned(next, nextGroupId, taskId, now)
  return next
}

/** Editable fields on a group (the update patch surface). */
export interface GroupUpdatePatch {
  name?: string
  mode?: GroupExecutionMode
  /** `null` clears the cap (parallel = unlimited). */
  maxParallel?: number | null
  /** `null` clears the endpoint list (global default applies). */
  endpoints?: string[] | null
  /** `null` clears the allowed-hours window. */
  allowedHours?: DailyWindow | null
  offPeakOnly?: boolean
  /** Sequential only: reuse one DSH session for every member (context continuity). */
  maintainSession?: boolean
  /** Sequential only (with maintainSession): run /compact on the shared session between members. */
  compactBetween?: boolean
  /** Designate one member (a member task id) as the group's final step; `null` clears it. */
  finalStepTaskId?: string | null
  /** Only with a final step: require every other member to succeed (done) before it runs. */
  finalStepRequireSuccess?: boolean
  /** Stop (true) or resume (false) the group: no member launches while stopped. */
  stopped?: boolean
  /** `null` removes the schedule rule; an object sets it (cron validated when enabled). */
  schedule?: { enabled?: boolean; cron?: string } | null
}

/** Result of a group update transition. */
export interface UpdateGroupResult {
  groups: readonly TaskGroupRecord[]
  /** Whether the patch was applied (false = unknown group / invalid value). */
  applied: boolean
}

/**
 * Apply an update across the group list. A blank name, an unknown mode, an
 * out-of-range maxParallel, a malformed endpoint/window, or an enabled
 * schedule with an invalid cron rejects the whole patch (state untouched).
 */
export function applyUpdateGroup(
  groups: readonly TaskGroupRecord[],
  groupId: string,
  patch: GroupUpdatePatch,
  now: number,
): UpdateGroupResult {
  const group = groups.find(candidate => candidate.id === groupId)
  if (group === undefined) return { groups, applied: false }
  const name = 'name' in patch ? normalizeGroupName(patch.name) : undefined
  if ('name' in patch && name === undefined) return { groups, applied: false }
  const mode = 'mode' in patch && patch.mode !== undefined && isGroupExecutionMode(patch.mode) ? patch.mode : undefined
  if ('mode' in patch && patch.mode !== undefined && mode === undefined) return { groups, applied: false }
  const maxParallel = 'maxParallel' in patch
    ? (patch.maxParallel === null || patch.maxParallel === undefined ? undefined : normalizeMaxParallel(patch.maxParallel))
    : undefined
  if ('maxParallel' in patch && patch.maxParallel !== null && patch.maxParallel !== undefined && maxParallel === undefined) {
    return { groups, applied: false }
  }
  const endpoints = 'endpoints' in patch
    ? (patch.endpoints === null || patch.endpoints === undefined ? undefined : normalizeEndpointList(patch.endpoints))
    : undefined
  if ('endpoints' in patch && patch.endpoints !== null && patch.endpoints !== undefined && endpoints === undefined) {
    return { groups, applied: false }
  }
  const allowedHours = 'allowedHours' in patch
    ? (patch.allowedHours === null || patch.allowedHours === undefined ? undefined : normalizeDailyWindow(patch.allowedHours))
    : undefined
  if ('allowedHours' in patch && patch.allowedHours !== null && patch.allowedHours !== undefined && allowedHours === undefined) {
    return { groups, applied: false }
  }
  // The final step must be a current member (the order covers exactly the
  // members); a null/blank value clears the designation.
  if ('finalStepTaskId' in patch && patch.finalStepTaskId !== null && patch.finalStepTaskId !== undefined) {
    const finalStepTaskId = patch.finalStepTaskId.trim()
    if (finalStepTaskId === '' || finalStepTaskId.length > GROUP_FIELD_BOUND || !group.order.includes(finalStepTaskId)) {
      return { groups, applied: false }
    }
  }
  let schedule = group.schedule
  if ('schedule' in patch) {
    if (patch.schedule === null) {
      schedule = undefined
    } else {
      const requested = patch.schedule
      const cron = (requested?.cron ?? group.schedule?.cron ?? '').trim()
      if (cron === '' || !isValidCron(cron)) return { groups, applied: false }
      const enabled = requested?.enabled ?? group.schedule?.enabled ?? false
      const nextRunAt = enabled ? nextRunAtMs(cron, now) : undefined
      if (enabled && nextRunAt === undefined) return { groups, applied: false }
      schedule = {
        enabled,
        cron,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(group.schedule?.lastTriggeredAt === undefined ? {} : { lastTriggeredAt: group.schedule.lastTriggeredAt }),
      }
    }
  }
  const next: TaskGroupRecord = {
    ...group,
    ...('name' in patch ? { name: name! } : {}),
    ...(mode === undefined ? {} : { mode }),
    ...('offPeakOnly' in patch ? { offPeakOnly: patch.offPeakOnly === true } : {}),
    updatedAt: now,
  }
  if ('stopped' in patch) {
    if (patch.stopped === true) next.stopped = true
    else delete next.stopped
  }
  if ('maintainSession' in patch) {
    if (patch.maintainSession === true) next.maintainSession = true
    else delete next.maintainSession
  }
  if ('compactBetween' in patch) {
    if (patch.compactBetween === true) next.compactBetween = true
    else delete next.compactBetween
  }
  if ('finalStepTaskId' in patch) {
    const finalStepTaskId = patch.finalStepTaskId === null || patch.finalStepTaskId === undefined
      ? undefined
      : patch.finalStepTaskId.trim()
    if (finalStepTaskId === undefined || finalStepTaskId === '') delete next.finalStepTaskId
    else next.finalStepTaskId = finalStepTaskId
  }
  if ('finalStepRequireSuccess' in patch) {
    if (patch.finalStepRequireSuccess === true) next.finalStepRequireSuccess = true
    else delete next.finalStepRequireSuccess
  }
  if ('maxParallel' in patch) {
    if (maxParallel !== undefined) next.maxParallel = maxParallel
    else delete next.maxParallel
  }
  if ('endpoints' in patch) {
    if (endpoints !== undefined) next.endpoints = endpoints
    else delete next.endpoints
  }
  if ('allowedHours' in patch) {
    if (allowedHours !== undefined) next.allowedHours = allowedHours
    else delete next.allowedHours
  }
  if ('schedule' in patch) {
    if (schedule !== undefined) next.schedule = schedule
    else delete next.schedule
  }
  return { groups: groups.map(candidate => candidate.id === groupId ? next : candidate), applied: true }
}

/** Delete a group: members are ungrouped (their tasks stay). */
export function applyDeleteGroup(
  tasks: readonly TaskRecord[],
  groups: readonly TaskGroupRecord[],
  groupId: string,
  now: number,
): { tasks: TaskRecord[]; groups: TaskGroupRecord[]; applied: boolean } {
  if (!groups.some(group => group.id === groupId)) return { tasks: [...tasks], groups: [...groups], applied: false }
  return {
    tasks: tasks.map(task => {
      if (task.groupId !== groupId) return task
      const { groupId: _removed, ...rest } = task
      return { ...rest, updatedAt: now }
    }),
    groups: groups.filter(group => group.id !== groupId),
    applied: true,
  }
}

/** Roll a group's schedule rule forward (scheduler callback); no-op without a rule. */
export function withGroupScheduleRoll(
  groups: readonly TaskGroupRecord[],
  groupId: string,
  nextRunAt: number | undefined,
  lastTriggeredAt: number | undefined,
  now: number,
): TaskGroupRecord[] {
  return groups.map(group =>
    group.id === groupId && group.schedule !== undefined
      ? { ...group, schedule: { ...group.schedule, nextRunAt, lastTriggeredAt }, updatedAt: now }
      : group)
}

/**
 * Normalize a persisted group row: valid rows are kept (deduplicated by id,
 * order re-derived from the member tasks); malformed rows are dropped. A
 * group's schedule is repaired field by field like a task schedule. Each
 * row's workspace scope is normalized too: an explicit value wins, and a
 * legacy row without one adopts its members' workspace (single distinct
 * workspace, else the unassigned scope) — the one-time migration that makes
 * existing global groups workspace-scoped. Members outside the group's scope
 * never enter its order.
 */
export function normalizeGroupRows(values: unknown, tasks: readonly TaskRecord[]): TaskGroupRecord[] {
  if (!Array.isArray(values)) return []
  // Member workspace distribution per group id: it lets a legacy row without
  // an explicit scope adopt its members' workspace (the migration path), and
  // keeps members outside the group's scope out of its order.
  const membersByGroup = new Map<string, { ids: string[]; scopes: Set<string | undefined> }>()
  for (const task of tasks) {
    if (task.groupId === undefined) continue
    const entry = membersByGroup.get(task.groupId) ?? { ids: [], scopes: new Set<string | undefined>() }
    entry.ids.push(task.id)
    entry.scopes.add(task.workspaceId)
    membersByGroup.set(task.groupId, entry)
  }
  const groups: TaskGroupRecord[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    const id = typeof row.id === 'string' && row.id !== '' && row.id.length <= GROUP_FIELD_BOUND ? row.id : undefined
    const name = normalizeGroupName(row.name)
    if (id === undefined || name === undefined || seen.has(id)) continue
    seen.add(id)
    const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt
    const schedule = normalizeGroupSchedule(row.schedule)
    // The group's scope: an explicit row value wins; a legacy row without one
    // adopts the single distinct workspace of its members (a mixed or empty
    // membership leaves it in the unassigned scope, where only unassigned
    // tasks may join).
    const explicitScope = normalizeTargetId(typeof row.workspaceId === 'string' ? row.workspaceId : undefined)
    const memberScopes = membersByGroup.get(id)?.scopes ?? new Set<string | undefined>()
    const workspaceId = explicitScope !== undefined
      ? explicitScope
      : memberScopes.size === 1 ? [...memberScopes][0] : undefined
    const memberIds = (membersByGroup.get(id)?.ids ?? []).filter(taskId => {
      const member = tasks.find(candidate => candidate.id === taskId)
      return member !== undefined && member.workspaceId === workspaceId
    })
    // The final-step designation must point at a member of the group's scope;
    // a dangling or foreign reference is dropped (like the order normalization).
    const finalStepTaskId = typeof row.finalStepTaskId === 'string'
      && row.finalStepTaskId.trim() !== ''
      && row.finalStepTaskId.length <= GROUP_FIELD_BOUND
      && memberIds.includes(row.finalStepTaskId)
      ? row.finalStepTaskId
      : undefined
    groups.push({
      id,
      name,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      mode: isGroupExecutionMode(row.mode) ? row.mode : 'sequential',
      ...(row.maxParallel === undefined ? {} : (() => {
        const maxParallel = normalizeMaxParallel(row.maxParallel)
        return maxParallel === undefined ? {} : { maxParallel }
      })()),
      ...(row.endpoints === undefined ? {} : (() => {
        const endpoints = normalizeEndpointList(row.endpoints)
        return endpoints === undefined ? {} : { endpoints }
      })()),
      ...(row.allowedHours === undefined ? {} : (() => {
        const allowedHours = normalizeDailyWindow(row.allowedHours)
        return allowedHours === undefined ? {} : { allowedHours }
      })()),
      offPeakOnly: row.offPeakOnly === true,
      ...(row.stopped === true ? { stopped: true } : {}),
      ...(row.paused === true ? { paused: true } : {}),
      ...(row.maintainSession === true ? { maintainSession: true } : {}),
      ...(row.compactBetween === true ? { compactBetween: true } : {}),
      ...(finalStepTaskId === undefined ? {} : { finalStepTaskId }),
      // `finalStepRequireSuccess` is only meaningful with a valid designation;
      // a dropped (dangling) reference drops it too.
      ...(finalStepTaskId === undefined || row.finalStepRequireSuccess !== true ? {} : { finalStepRequireSuccess: true }),
      ...(schedule === undefined ? {} : { schedule }),
      order: normalizeGroupOrder(row.order, memberIds),
      createdAt,
      updatedAt,
    })
  }
  return groups
}

/** Repair a persisted group schedule rule (drop malformed rules). */
export function normalizeGroupSchedule(value: unknown): GroupScheduleRule | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rule = value as Record<string, unknown>
  if (typeof rule.cron !== 'string' || rule.cron.trim() === '' || !isValidCron(rule.cron)) return undefined
  return {
    enabled: rule.enabled === true,
    cron: rule.cron,
    nextRunAt: typeof rule.nextRunAt === 'number' && Number.isFinite(rule.nextRunAt) ? rule.nextRunAt : undefined,
    lastTriggeredAt: typeof rule.lastTriggeredAt === 'number' && Number.isFinite(rule.lastTriggeredAt) ? rule.lastTriggeredAt : undefined,
  }
}

// --- execution policy (Host router + pure tests) -----------------------------

/**
 * The effective endpoint list for one member: the task's own pin wins, then
 * the group's list, then the workspace's default list, then undefined (the
 * global default list applies at the router). An empty effective list means
 * no routing (direct model pin).
 */
export function effectiveEndpointIds(
  task: { endpoints?: readonly string[] },
  group?: { endpoints?: readonly string[] },
  workspaceDefault?: readonly string[],
): string[] | undefined {
  if (task.endpoints !== undefined && task.endpoints.length > 0) return [...task.endpoints]
  if (group?.endpoints !== undefined && group.endpoints.length > 0) return [...group.endpoints]
  if (workspaceDefault !== undefined && workspaceDefault.length > 0) return [...workspaceDefault]
  return undefined
}

/**
 * Whether a group has reached its launch capacity: sequential groups allow one
 * launched member at a time; parallel groups allow up to maxParallel (absent =
 * unlimited).
 * @param launchedCount - members with an open launched execution.
 */
export function groupCapacityFull(group: { mode: GroupExecutionMode; maxParallel?: number }, launchedCount: number): boolean {
  if (group.mode === 'sequential') return launchedCount >= 1
  if (group.maxParallel !== undefined) return launchedCount >= group.maxParallel
  return false
}

/**
 * Whether member launches may proceed right now: inside the allowed-hours
 * window (host-local) and, for off-peak-only groups, inside the hard-coded
 * DeepSeek off-peak schedule (weekday-aware, weekends fully off-peak). A
 * missing local-minute probe (unusable time zone) skips the allowed-hours
 * constraint; an unusable off-peak clock skips the off-peak constraint,
 * mirroring the endpoint eligibility check.
 */
export function groupWindowOpen(
  group: { allowedHours?: DailyWindow; offPeakOnly: boolean },
  localMinutes: number | undefined,
  now: Date,
): boolean {
  if (group.allowedHours !== undefined && localMinutes !== undefined && !inDailyWindow(localMinutes, group.allowedHours)) {
    return false
  }
  if (group.offPeakOnly && !isOffPeakNow(now)) {
    return false
  }
  return true
}

/**
 * Whether a group's sequence has started: any current member carries an
 * execution record (open or settled). Members joining a started group are
 * held from auto-advance ({@link TaskRecord.deferAutoStart}) so the chain
 * never picks up work that entered after the sequence began — the sequence
 * advances only through members that were already in the group when it ran.
 * A fresh, never-run group returns false and joins stay unheld.
 */
export function groupSequenceStarted(group: TaskGroupRecord, tasks: readonly TaskRecord[]): boolean {
  return tasks.some(task => task.groupId === group.id && task.executions.length > 0)
}

/**
 * The next member that may auto-start: the first group-order member that is
 * on-board, in a pre-execution column (backlog/todo), has no open execution,
 * and is not held from auto-advance ({@link TaskRecord.deferAutoStart}).
 * Done/failed/archived/running/held members are skipped — auto-advance never
 * re-runs settled work, races a running one, or starts a member that joined
 * the group after its sequence began. The group's final step is skipped too:
 * it runs only through its own gate ({@link groupFinalStepReady}), never as
 * part of the regular chain.
 */
export function nextRunnableMember(group: TaskGroupRecord, tasks: readonly TaskRecord[]): TaskRecord | undefined {
  for (const id of group.order) {
    if (id === group.finalStepTaskId) continue
    const task = tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined) continue
    if (task.status !== 'backlog' && task.status !== 'todo') continue
    if (task.deferAutoStart === true) continue
    if (task.executions.some(execution => execution.endedAt === undefined)) continue
    return task
  }
  return undefined
}

/**
 * The member tasks of a group in group order, followed by any member missing
 * from the order (defensive; the ledger keeps the order complete). Members
 * whose workspace pin does not match the group's scope are excluded (the Host
 * keeps the ledger consistent, so this only fires on foreign task lists).
 */
export function orderedGroupMembers(group: TaskGroupRecord, tasks: readonly TaskRecord[]): TaskRecord[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const ordered: TaskRecord[] = []
  const seen = new Set<string>()
  for (const id of group.order) {
    const task = byId.get(id)
    if (task === undefined || !taskMatchesGroupScope(task, group)) continue
    ordered.push(task)
    seen.add(id)
  }
  for (const task of tasks) {
    if (task.groupId === group.id && !seen.has(task.id) && taskMatchesGroupScope(task, group)) ordered.push(task)
  }
  return ordered
}

/**
 * Open-execution status of one group, derived from its member tasks: how many
 * members have a launched run (a session is executing) and how many are held
 * before launch (queued for a group slot, the allowed window, or an endpoint —
 * or still in the brief pre-route window). The board banner renders these as
 * the group's Running / Pending badges, so a group that is mid-sequence or
 * waiting never looks idle from any column.
 */
export interface GroupRuntimeStatus {
  /** Members with an open launched execution (a session is executing). */
  running: number
  /** Members with an open held execution (no session yet; queued or in flight). */
  pending: number
  /**
   * Why held members wait, in first-seen order and deduplicated ('group' |
   * 'window' | 'endpoint' | 'workspace'); empty when nothing is pending.
   */
  pendingReasons: readonly ExecutionQueuedReason[]
  /**
   * Whether the group's final step is gated on unsettled members (the banner
   * shows a waiting pill so the merge step is never mistaken for an idle one).
   */
  finalStepWaiting: boolean
}

/** Derive one group's runtime status from its member tasks (see the interface). */
export function groupRuntimeStatus(group: TaskGroupRecord, tasks: readonly TaskRecord[]): GroupRuntimeStatus {
  let running = 0
  let pending = 0
  const pendingReasons: ExecutionQueuedReason[] = []
  for (const task of tasks) {
    if (task.groupId !== group.id) continue
    for (const execution of task.executions) {
      if (execution.endedAt !== undefined) continue
      if (execution.sessionId !== undefined) {
        running += 1
      } else {
        pending += 1
        if (execution.queuedReason !== undefined && !pendingReasons.includes(execution.queuedReason)) {
          pendingReasons.push(execution.queuedReason)
        }
      }
    }
  }
  return {
    running,
    pending,
    pendingReasons,
    finalStepWaiting: groupFinalStepBlocked(group, tasks),
  }
}

/**
 * Whether a sequential group maintains one DSH session across its members.
 * Only sequential mode may share a session (parallel members would collide on
 * one conversation); the flag is deliberately ignored for parallel groups.
 */
export function groupSharesSession(group: Pick<TaskGroupRecord, 'mode' | 'maintainSession'>): boolean {
  return group.mode === 'sequential' && group.maintainSession === true
}

/**
 * Whether a sequential group compacts its shared session between members.
 * Compaction only makes sense when the session is shared, so the flag is
 * honored only when `maintainSession` is also enabled.
 */
export function groupCompactsBetween(group: Pick<TaskGroupRecord, 'mode' | 'maintainSession' | 'compactBetween'>): boolean {
  return groupSharesSession(group) && group.compactBetween === true
}

/**
 * Whether a group's final step is blocked from launching: any non-final
 * member is still unfinished — it has an open execution (running/queued/
 * paused) or it is not in a settled status. Archived members are out of the
 * sequence and never block. With `finalStepRequireSuccess`, only the done
 * column counts as finished (a failed member blocks the gate); otherwise any
 * settled outcome (done or failed) opens it. A group without a designated
 * final step is never blocked.
 */
export function groupFinalStepBlocked(group: TaskGroupRecord, tasks: readonly TaskRecord[]): boolean {
  const finalStepTaskId = group.finalStepTaskId
  if (finalStepTaskId === undefined) return false
  for (const member of orderedGroupMembers(group, tasks)) {
    if (member.id === finalStepTaskId) continue
    if (member.archivedAt !== undefined) continue
    if (member.executions.some(execution => execution.endedAt === undefined)) return true
    if (group.finalStepRequireSuccess === true) {
      if (member.status !== 'done') return true
    } else if (member.status !== 'done' && member.status !== 'failed') {
      return true
    }
  }
  return false
}

/**
 * Whether the group's final step may launch right now: every other member is
 * settled ({@link groupFinalStepBlocked} passes) and the final step itself is
 * on-board, approved, not held from auto-advance, in backlog/todo, and has no
 * open execution — so it launches once per cycle and never re-runs after
 * settling until it is reset to a pre-execution column.
 */
export function groupFinalStepReady(group: TaskGroupRecord, tasks: readonly TaskRecord[]): boolean {
  if (group.finalStepTaskId === undefined) return false
  if (groupFinalStepBlocked(group, tasks)) return false
  const member = tasks.find(candidate => candidate.id === group.finalStepTaskId)
  if (member === undefined || member.archivedAt !== undefined) return false
  if (member.approved === false || member.deferAutoStart === true) return false
  if (member.status !== 'backlog' && member.status !== 'todo') return false
  if (member.executions.some(execution => execution.endedAt === undefined)) return false
  return true
}
