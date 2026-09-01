/**
 * Board controller: the single owner of task-ledger state and view state.
 *
 * In production it projects the Host ledger and submits confirmed actions;
 * the legacy store seam remains for v1 migration tests. The board closes
 * only on explicit user navigation, never implicitly on session-list churn.
 * Framework-free (structural runtime faces) so the whole orchestration is
 * unit-testable with fakes.
 *
 * The per use-case domain transitions (create/update/delete/schedule) live in
 * dedicated modules under core/use-cases and are applied here; the controller
 * owns only the orchestration seam (state, persistence, notify, navigation).
 */
import type { TaskStore } from './store.ts'
import {
  applyCreateGroup,
  applyDeleteGroup,
  applyUpdateGroup,
  orderedGroupMembers,
  withGroupMembershipChange,
  withGroupOrder,
  type GroupCreateInput,
  type GroupUpdatePatch,
  type TaskGroupRecord,
} from './groups.ts'
import { withStatus, moveTaskBefore, type NewTaskInput, type TaskRecord, type TaskStatus } from './tasks.ts'
import { applyArchiveTask, applyRestoreTask } from './use-cases/task-archive.ts'
import { applyCreateTask } from './use-cases/task-create.ts'
import { applyDeleteTask } from './use-cases/task-delete.ts'
import { applyScheduleNextRun as applyScheduleRollForward, applySetSchedule } from './use-cases/task-schedule.ts'
import { applyUpdateTask, type TaskUpdatePatch } from './use-cases/task-update.ts'
import { applyWorkspaceDefaultsPatch, type WorkspaceDefaultsPatch, type WorkspaceDefaultsRecord } from './workspace-defaults.ts'
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardSnapshot } from '../protocol.ts'

export interface TaskBoardTransport {
  bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>
  state(): Promise<TaskBoardSnapshot>
  action(action: TaskBoardAction): Promise<TaskBoardSnapshot>
  subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void
}

/** The sessions face the controller needs for navigation awareness. */
export interface SessionsControllerFace {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
  /** Select a session as current (navigates the conversation view). */
  open(id: string): void
}

/** Controller dependencies (all swappable in tests). */
export interface ControllerDeps {
  store: TaskStore
  sessions: SessionsControllerFace
  /** Clock; defaults to Date.now. */
  now?: () => number
  /** Id minting; defaults to a random-uuid. */
  uuid?: () => string
  /** Host-authoritative transport; absent keeps the legacy in-memory test path. */
  transport?: TaskBoardTransport
}

/** One workspace option the execution-target pickers offer. */
export interface ExecutionWorkspaceOption {
  workspaceId: string
  /** Display label (workspace title; the wiring falls back to the path). */
  title: string
}

/** One agent-preset option the execution-target pickers offer. */
export interface ExecutionPresetOption {
  id: string
  name?: string
  description?: string
  /** Why this preset cannot compose a session; the pickers disable it. */
  broken?: string
  isDefault: boolean
}

/** One model option the execution-target picker offers (flattened from the host model catalog). */
export interface ExecutionModelOption {
  /** Registered provider route id. */
  provider: string
  /** Provider display name. */
  providerName: string
  /** Provider-owned model id. */
  model: string
  /** Model display name; pickers fall back to the model id. */
  modelName?: string
}

/** One endpoint option the execution-target picker offers (from the plugin settings). */
export interface ExecutionEndpointOption {
  /** Stable endpoint id. */
  id: string
  /** Display name. */
  name: string
}

/** The execution-target option sets the UI feeds into the controller. */
export interface ExecutionOptionsSnapshot {
  workspaces: readonly ExecutionWorkspaceOption[]
  presets: readonly ExecutionPresetOption[]
  models: readonly ExecutionModelOption[]
  endpoints: readonly ExecutionEndpointOption[]
}

/**
 * Group the flat model option list by provider, in first-seen provider order.
 * The board's model picker renders one optgroup per provider.
 */
export function groupExecutionModelOptions(
  options: readonly ExecutionModelOption[],
): { provider: string; providerName: string; models: readonly ExecutionModelOption[] }[] {
  const byProvider = new Map<string, ExecutionModelOption[]>()
  for (const option of options) {
    const list = byProvider.get(option.provider)
    if (list === undefined) byProvider.set(option.provider, [option])
    else list.push(option)
  }
  return [...byProvider.entries()].map(([provider, models]) => ({
    provider,
    providerName: models[0]?.providerName ?? provider,
    models,
  }))
}

/** Immutable controller snapshot for UI subscriptions. */
export interface ControllerSnapshot {
  tasks: readonly TaskRecord[]
  /** Task groups (named member sets with shared execution policy). */
  groups: readonly TaskGroupRecord[]
  /**
   * Per-workspace execution defaults for new tasks, keyed by workspace id
   * (Host-authoritative; the legacy seam keeps them in memory).
   */
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>
  boardOpen: boolean
  /** True when the board shows the archive view instead of the columns. */
  archiveView: boolean
  selectedTaskId: string | undefined
  /** Picker option sets (workspace list + agent-preset roster). */
  executionOptions: ExecutionOptionsSnapshot
  pendingTaskIds: readonly string[]
  transportError?: string
  host?: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power'>
}

/** The selected task (resolved from the ledger), or undefined. */
export function selectedTaskOf(snapshot: ControllerSnapshot): TaskRecord | undefined {
  if (snapshot.selectedTaskId === undefined) return undefined
  return snapshot.tasks.find(task => task.id === snapshot.selectedTaskId)
}

function randomUuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID !== undefined) {
    return randomUUID.call(globalThis.crypto!)
  }
  const bytes = globalThis.crypto?.getRandomValues(new Uint8Array(16))
  if (bytes === undefined) {
    // Non-secure fallback (tests, odd environments).
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Board controller (see module doc). All mutations bump the snapshot and
 * persist through the store; UI and DOM mounts subscribe and re-render.
 */
export class BoardController {
  private tasks: TaskRecord[] = []
  private groups: TaskGroupRecord[] = []
  private workspaceDefaults: Record<string, WorkspaceDefaultsRecord> = {}
  private boardOpen = false
  private archiveView = false
  private selectedTaskId: string | undefined
  private executionOptions: ExecutionOptionsSnapshot = { workspaces: [], presets: [], models: [], endpoints: [] }
  private listeners = new Set<() => void>()
  private disposers: Array<() => void> = []
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly pendingTaskIds = new Set<string>()
  private readonly taskQueues = new Map<string, Promise<void>>()
  private transportError: string | undefined
  private hostState: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power'> | undefined
  private remoteSubscribed = false
  private remoteInitialization: Promise<boolean> | undefined

  /** @param deps - store and the sessions navigation face. */
  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.uuid = deps.uuid ?? randomUuid
  }

  // --- lifecycle -------------------------------------------------------------

  /** Load the persisted ledger and start the navigation/status subscriptions. */
  start(): void {
    this.tasks = this.deps.store.load()
    if (this.deps.transport !== undefined) void this.initializeRemote()
    // A sibling tab may have edited or deleted the ledger (same origin,
    // storage events). Reload on external change so a task deleted in
    // another tab stops firing here — and is never written back by this
    // tab's stale copy (scheduler roll-forward, execution settlement).
    const unsubscribeExternal = this.deps.transport === undefined ? this.deps.store.subscribeExternal?.(() => {
      this.tasks = this.deps.store.load()
      this.notify()
    }) : undefined
    if (unsubscribeExternal !== undefined) this.disposers.push(unsubscribeExternal)
    this.disposers.push(this.deps.sessions.list.subscribe(() => {
      this.onSessionsChanged()
    }))
    this.notify()
  }

  /** Stop all subscriptions and drop retained state (idempotent). */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.listeners.clear()
  }

  // --- snapshot / subscription ------------------------------------------------

  getSnapshot(): ControllerSnapshot {
    return {
      tasks: this.tasks,
      groups: this.groups,
      workspaceDefaults: this.workspaceDefaults,
      boardOpen: this.boardOpen,
      archiveView: this.archiveView,
      selectedTaskId: this.selectedTaskId,
      executionOptions: this.executionOptions,
      pendingTaskIds: [...this.pendingTaskIds],
      ...(this.transportError === undefined ? {} : { transportError: this.transportError }),
      ...(this.hostState === undefined ? {} : { host: this.hostState }),
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Whether production mutations are confirmed by the Host transport. */
  isHostBacked(): boolean {
    return this.deps.transport !== undefined
  }

  /** Retry initial migration/state synchronization after an explicit Host error. */
  async retryHostSync(): Promise<boolean> {
    return await this.initializeRemote()
  }

  // --- view state -------------------------------------------------------------

  openBoard(): void {
    if (this.boardOpen) return
    this.boardOpen = true
    this.notify()
  }

  closeBoard(): void {
    this.boardOpen = false
    this.notify()
  }

  toggleBoard(): void {
    if (this.boardOpen) this.closeBoard()
    else this.openBoard()
  }

  /**
   * Switch between the kanban columns and the archive view. Leaving the
   * archive view with an archived task still selected closes the selection —
   * the detail overlay must not linger over a task that is off-board.
   */
  toggleArchiveView(): void {
    this.archiveView = !this.archiveView
    if (!this.archiveView && this.selectedTaskId !== undefined) {
      const selected = this.tasks.find(task => task.id === this.selectedTaskId)
      if (selected?.archivedAt !== undefined) this.selectedTaskId = undefined
    }
    this.notify()
  }

  openTask(id: string): void {
    if (this.tasks.some(task => task.id === id)) {
      this.selectedTaskId = id
      this.notify()
    }
  }

  closeTask(): void {
    if (this.selectedTaskId === undefined) return
    this.selectedTaskId = undefined
    this.notify()
  }

  // --- task mutations (use-case transitions in core/use-cases) -----------------

  createTask(input: NewTaskInput): TaskRecord | undefined {
    const id = this.uuid()
    const { task, tasks } = applyCreateTask(this.tasks, input, this.now(), id)
    if (task === undefined) return undefined
    this.tasks = [...tasks]
    // Legacy path only: the Host ledger syncs the group order on its own.
    if (task.groupId !== undefined && this.groups.some(group => group.id === task.groupId)) {
      this.groups = withGroupMembershipChange(this.groups, id, undefined, task.groupId, this.now())
    }
    this.persistAndNotify()
    return task
  }

  /** Create through the Host and expose the task only after confirmation. */
  async createTaskConfirmed(input: NewTaskInput): Promise<TaskRecord | undefined> {
    if (this.deps.transport === undefined) return this.createTask(input)
    const id = this.uuid()
    const preview = applyCreateTask(this.tasks, input, this.now(), id).task
    if (preview === undefined) return undefined
    return await this.commitRemote({ kind: 'create', id, input }, id)
      ? this.tasks.find(task => task.id === id)
      : undefined
  }

  /**
   * Apply an editable-field patch (task content + execution targets).
   * Host-backed: the Host ledger owns the fail-closed checks (the content of
   * an executed task is read-only) and confirms the mutation, so the resolved
   * value reflects whether the Host accepted it; the legacy in-memory path
   * applies and persists synchronously.
   * @returns true when the patch was accepted by the authority.
   */
  async updateTask(id: string, patch: TaskUpdatePatch): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'update', taskId: id, patch }, id)
    }
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined) return false
    const previous = task.groupId
    // Mirror the Host ledger: a running member keeps its group's capacity slot
    // until its execution settles; moving it between groups (or out) would let
    // the old group start a second member while the first is still running.
    const nextGroupId = 'groupId' in patch
      ? (patch.groupId === null || patch.groupId === undefined ? undefined : patch.groupId.trim() === '' ? undefined : patch.groupId.trim())
      : previous
    if (previous !== nextGroupId && (task.status === 'running' || task.executions.some(execution => execution.endedAt === undefined))) {
      return false
    }
    this.tasks = [...applyUpdateTask(this.tasks, id, patch, this.now())]
    // Legacy path only: the Host ledger syncs the group order on its own.
    if (previous !== nextGroupId) {
      this.groups = withGroupMembershipChange(this.groups, id, previous, nextGroupId, this.now())
    }
    this.persistAndNotify()
    return true
  }

  /**
   * Replace (a part of) the picker option sets the UI feeds (workspace list
   * and agent-preset roster come from the runtime, not the ledger).
   */
  setExecutionOptions(patch: Partial<ExecutionOptionsSnapshot>): void {
    this.executionOptions = { ...this.executionOptions, ...patch }
    this.notify()
  }

  moveTask(id: string, status: TaskStatus): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'move', taskId: id, status }, id)
      return
    }
    this.tasks = this.tasks.map(task => task.id === id ? withStatus(task, status, this.now()) : task)
    this.persistAndNotify()
  }

  /**
   * Reorder one task directly above another in the ledger array (the display
   * order for ungrouped cards inside a column). `beforeTaskId` is the task
   * the moved task should sit above; `undefined` moves it to the end. The
   * move is a pure position change — status and group membership are kept.
   */
  reorderTask(id: string, beforeTaskId: string | undefined): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'reorder', taskId: id, beforeTaskId: beforeTaskId ?? null }, id)
      return
    }
    this.tasks = [...moveTaskBefore(this.tasks, id, beforeTaskId)]
    this.persistAndNotify()
  }

  deleteTask(id: string): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'delete', taskId: id }, id)
      return
    }
    const previous = this.tasks.find(task => task.id === id)?.groupId
    const { tasks, selectionCleared } = applyDeleteTask(this.tasks, this.selectedTaskId, id)
    this.tasks = [...tasks]
    // Legacy path only: the Host ledger syncs the group order on its own.
    if (previous !== undefined) {
      this.groups = withGroupMembershipChange(this.groups, id, previous, undefined, this.now())
    }
    if (selectionCleared) this.selectedTaskId = undefined
    this.persistAndNotify()
  }

  /**
   * Archive a settled task (done/failed). Running or on-board-unsettled
   * tasks are refused so the runner keeps exclusive ownership of their
   * lifecycle.
   * @returns true when applied.
   */
  archiveTask(id: string): boolean {
    const { tasks, archived } = applyArchiveTask(this.tasks, id, this.now())
    if (!archived) return false
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'archive', taskId: id }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /** Restore an archived task back onto the board (same status column). */
  restoreTask(id: string): boolean {
    const { tasks, archived } = applyRestoreTask(this.tasks, id, this.now())
    if (!archived) return false
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'restore', taskId: id }, id).then(restored => {
        if (restored && this.selectedTaskId === id) this.closeTask()
      })
      return true
    }
    this.tasks = [...tasks]
    if (this.selectedTaskId === id) this.selectedTaskId = undefined
    this.persistAndNotify()
    return true
  }

  // --- group mutations (pure transitions in core/groups) ----------------------

  /** Create a group through the Host; exposes it only after confirmation. */
  async createGroupConfirmed(input: GroupCreateInput): Promise<TaskGroupRecord | undefined> {
    const id = this.uuid()
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'create-group', id, input }, id)
        ? this.groups.find(group => group.id === id)
        : undefined
    }
    const result = applyCreateGroup(this.groups, input, this.now(), id)
    if (result.group === undefined) return undefined
    this.groups = [...result.groups]
    this.notify()
    return result.group
  }

  /**
   * Update a group (name, mode, cap, endpoints, window, schedule).
   * @returns true when the authority accepted the patch.
   */
  async updateGroup(groupId: string, patch: GroupUpdatePatch): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'update-group', groupId, patch }, groupId)
    }
    const result = applyUpdateGroup(this.groups, groupId, patch, this.now())
    if (!result.applied) return false
    this.groups = [...result.groups]
    this.notify()
    return true
  }

  /** Delete a group (members become ungrouped; their tasks stay). */
  async deleteGroup(groupId: string): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'delete-group', groupId }, groupId)
    }
    const result = applyDeleteGroup(this.tasks, this.groups, groupId, this.now())
    if (!result.applied) return false
    this.tasks = [...result.tasks]
    this.groups = [...result.groups]
    this.notify()
    return true
  }

  /** Replace a group's member order (every listed id must be a member, once). */
  async setGroupOrder(groupId: string, order: string[]): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'set-group-order', groupId, order }, groupId)
    }
    const memberIds = this.tasks.filter(task => task.groupId === groupId).map(task => task.id)
    const memberSet = new Set(memberIds)
    const orderSet = new Set(order)
    if (orderSet.size !== order.length || !order.every(id => memberSet.has(id))) return false
    this.groups = withGroupOrder(this.groups, groupId, order, memberIds, this.now())
    this.notify()
    return true
  }

  /** The member tasks of a group in group order (for pickers and editors). */
  groupMembers(groupId: string): TaskRecord[] {
    const group = this.groups.find(candidate => candidate.id === groupId)
    return group === undefined ? [] : orderedGroupMembers(group, this.tasks)
  }

  // --- scheduling ---------------------------------------------------------------

  /**
   * Update a task's schedule rule. A blank or invalid cron expression is
   * rejected (returns false, state untouched). When the rule ends up enabled
   * the next run instant is computed immediately; a disabled rule carries no
   * next-run instant. Delegates the domain transition to the schedule use case.
   * @param id - the task to schedule.
   * @param patch - fields to change (absent fields keep their current value).
   * @returns true when applied, false when rejected (invalid cron / unknown task).
   */
  setSchedule(id: string, patch: { enabled?: boolean; cron?: string }): boolean {
    const { tasks, applied } = applySetSchedule(this.tasks, id, patch, this.now())
    if (!applied) return false
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'set-schedule', taskId: id, patch }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /**
   * Legacy pure-controller seam retained for migration-focused tests. The
   * production browser never rolls schedules; the Host ledger owns them.
   */
  applyScheduleNextRun(id: string, nextRunAt: number | undefined, lastTriggeredAt: number | undefined): void {
    const next = applyScheduleRollForward(this.tasks, id, nextRunAt, lastTriggeredAt, this.now())
    this.tasks = [...next]
    this.persistAndNotify()
  }

  /**
   * Reload the legacy v1 store without notifying subscribers. Production v2
   * reads Host snapshots instead; this remains only for isolated legacy tests.
   */
  reloadFromStore(): void {
    this.tasks = this.deps.store.load()
  }

  /**
   * Jump to an execution's session transcript. Selecting the session changes
   * `current`, which closes the board (the conversation view takes over).
   * @param sessionId - the execution session to open.
   */
  openSession(sessionId: string): void {
    this.closeBoard()
    this.deps.sessions.open(sessionId)
  }

  // --- execution ---------------------------------------------------------------

  /**
   * Request a Host execution for a task: the Host ledger owns the running
   * transition, the execution record, and the settlement. A second call
   * while the task is already running is ignored; without a Host transport
   * the run is refused (returns false).
   */
  async runTask(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status === 'running') return false
    // An unapproved task can never run by any means; refuse before the wire
    // round-trip (the Host ledger enforces the same gate).
    if (task.approved === false) return false
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'run', taskId: id }, id)
  }

  /** Re-run a settled task through the Host (the Host replans and executes). */
  async rerunTask(id: string): Promise<void> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined) return
    if (task.approved === false) return
    if (this.deps.transport === undefined) return
    await this.commitRemote({ kind: 'rerun', taskId: id }, id)
  }

  /** Stop one task's running execution (cancel the session, settle as cancelled). */
  async stopTask(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined) return false
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'stop', taskId: id }, id)
  }

  /**
   * Set a task's approval gate. An unapproved task can never be run by any
   * means (manual, cron, or group) until it is approved again; it stays fully
   * manageable (moves, edits, groups) either way.
   * @param id - the task to approve or unapprove.
   * @param approved - `true` clears the gate (default state); `false` gates it.
   */
  setApproved(id: string, approved: boolean): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'set-approved', taskId: id, approved }, id)
      return
    }
    this.tasks = this.tasks.map(task => {
      if (task.id !== id) return task
      const { approved: _current, ...rest } = task
      return approved ? { ...rest, updatedAt: this.now() } : { ...rest, approved: false, updatedAt: this.now() }
    })
    this.persistAndNotify()
  }

  /**
   * Set one workspace's new-task execution defaults (Host-authoritative).
   * A patch field set to `null` clears it; an all-blank result removes the
   * workspace's entry (new tasks then use the runtime defaults).
   * @param workspaceId - the workspace-list id the defaults key on.
   * @param patch - the fields to set or clear.
   * @returns true when the authority accepted the edit.
   */
  async setWorkspaceDefaults(workspaceId: string, patch: WorkspaceDefaultsPatch): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'set-workspace-defaults', workspaceId, patch }, workspaceId)
    }
    const next = applyWorkspaceDefaultsPatch(this.workspaceDefaults[workspaceId], patch)
    if (next === undefined) {
      if (this.workspaceDefaults[workspaceId] === undefined) return true
      const { [workspaceId]: _removed, ...rest } = this.workspaceDefaults
      this.workspaceDefaults = rest
    } else {
      this.workspaceDefaults = { ...this.workspaceDefaults, [workspaceId]: next }
    }
    this.notify()
    return true
  }

  /** Stop a whole group: cancel every open member execution and mark it stopped. */
  async stopGroup(groupId: string): Promise<boolean> {
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'stop-group', groupId }, groupId)
  }

  /**
   * Request a Host execution for a whole group: every runnable member
   * (on-board, approved, backlog/todo, no open run) opens an execution, and
   * the router launches up to the group's capacity now, queuing the rest
   * until a slot, the allowed window, or an endpoint frees. A stopped or
   * member-less group is refused before the wire round-trip; the Host ledger
   * enforces the same gates and rejects a group with no runnable member.
   */
  async runGroup(groupId: string): Promise<boolean> {
    const group = this.groups.find(candidate => candidate.id === groupId)
    if (group === undefined || group.stopped === true) return false
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'run-group', groupId }, groupId)
  }

  /** Resume a stopped group (member launches are allowed again). */
  async resumeGroup(groupId: string): Promise<boolean> {
    return await this.updateGroup(groupId, { stopped: false })
  }

  /** Move every on-board member of a group to one manual status column. */
  async moveGroup(groupId: string, status: TaskStatus): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'move-group', groupId, status }, groupId)
    }
    const members = this.tasks.filter(task => task.groupId === groupId && task.archivedAt === undefined)
    if (members.some(member => member.status === 'running')) return false
    this.tasks = this.tasks.map(task =>
      task.groupId === groupId && task.archivedAt === undefined ? withStatus(task, status, this.now()) : task)
    this.persistAndNotify()
    return true
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Session-list notifications fire for all kinds of incidental churn
   * (background navigation, the Host runner creating and selecting a fresh
   * execution session, settlement, other plugins), so closing on `current`
   * changes would evict the board without the user asking. The board closes
   * only on explicit user navigation: a sidebar session/workspace row click
   * (board-mount onClickSidebarRow) or the board's own actions
   * (openSession / close). Keeping the hook preserves the subscription
   * contract for future listeners.
   */
  private onSessionsChanged(): void {
    // Intentionally empty: never close the board implicitly.
  }

  private persistAndNotify(): void {
    if (this.deps.transport === undefined) this.deps.store.save(this.tasks)
    this.notify()
  }

  private async commitRemote(action: TaskBoardAction, taskId?: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    if (taskId === undefined) return await this.performRemote(action)
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => await this.performRemote(action))
    const tail = operation.then(() => {}, () => {})
    this.taskQueues.set(taskId, tail)
    this.pendingTaskIds.add(taskId)
    this.notify()
    try {
      return await operation
    } finally {
      if (this.taskQueues.get(taskId) === tail) {
        this.taskQueues.delete(taskId)
        this.pendingTaskIds.delete(taskId)
        this.notify()
      }
    }
  }

  private async performRemote(action: TaskBoardAction): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    this.transportError = undefined
    this.notify()
    try {
      const accepted = this.acceptRemote(await transport.action(action))
      return accepted || await this.refreshRemote()
    } catch (error) {
      await this.refreshRemote(messageOf(error))
      return false
    }
  }

  private async initializeRemote(): Promise<boolean> {
    if (this.remoteInitialization !== undefined) return await this.remoteInitialization
    const initialization = this.doInitializeRemote()
    this.remoteInitialization = initialization
    try {
      return await initialization
    } finally {
      if (this.remoteInitialization === initialization) this.remoteInitialization = undefined
    }
  }

  private async doInitializeRemote(): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      this.acceptRemote(await transport.bootstrap(this.tasks))
      if (!this.remoteSubscribed) {
        this.remoteSubscribed = true
        this.disposers.push(transport.subscribe((event) => { this.onRemoteEvent(event) }))
      }
      return true
    } catch (error) {
      this.transportError = messageOf(error)
      this.notify()
      return false
    }
  }

  /**
   * SSE frames carry revision/scheduler/power. When the revision matches the
   * one already applied, apply the frame's scheduler/power in place and skip
   * the full /state fetch; otherwise the 5 s heartbeat would re-clone and
   * re-serialize the whole ledger per tab even while nothing changes.
   */
  private onRemoteEvent(event: TaskBoardEventPayload | undefined): void {
    if (event !== undefined && this.hostState !== undefined && event.revision === this.hostState.revision
      && typeof event.scheduler === 'object' && event.scheduler !== null
      && typeof event.power === 'object' && event.power !== null) {
      this.hostState = { revision: event.revision, scheduler: event.scheduler, power: event.power }
      this.notify()
      return
    }
    void this.refreshRemote()
  }

  private async refreshRemote(preserveError?: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      this.acceptRemote(await transport.state())
      if (preserveError !== undefined) {
        this.transportError = preserveError
        this.notify()
      }
      return true
    } catch (error) {
      this.transportError = preserveError ?? messageOf(error)
      this.notify()
      return false
    }
  }

  private acceptRemote(snapshot: TaskBoardSnapshot): boolean {
    const currentLedgerId = this.hostState?.scheduler.ledgerId
    const nextLedgerId = snapshot.scheduler.ledgerId
    const sameGeneration = currentLedgerId === nextLedgerId
    if (sameGeneration && this.hostState !== undefined && snapshot.revision < this.hostState.revision) return false
    this.tasks = [...snapshot.tasks]
    this.groups = [...snapshot.groups]
    // Tolerant of pre-feature snapshots (an older Host without the field).
    this.workspaceDefaults = snapshot.workspaceDefaults ?? {}
    this.hostState = { revision: snapshot.revision, scheduler: snapshot.scheduler, power: snapshot.power }
    this.transportError = undefined
    if (this.selectedTaskId !== undefined && !this.tasks.some(task => task.id === this.selectedTaskId)) {
      this.selectedTaskId = undefined
    }
    if (!this.archiveView && this.selectedTaskId !== undefined
      && this.tasks.find(task => task.id === this.selectedTaskId)?.archivedAt !== undefined) {
      this.selectedTaskId = undefined
    }
    this.notify()
    return true
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
