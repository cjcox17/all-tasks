import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { clockMinutesInTimeZone, pickEndpoint, shouldUseRouter, type EndpointRouterConfig, type RouteDecision } from './core/endpoints.ts'
import { effectiveEndpointIds, groupCapacityFull, groupWindowOpen } from './core/groups.ts'
import { nextRunAtMs } from './core/schedule.ts'
import type { TaskRecord } from './core/tasks.ts'
import { resolveExecutionTargets } from './core/workspace-defaults.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference, type QueuedRunReference } from './host-ledger.ts'
import { HostExecutionRunner, SessionLaunchError, type SessionCommandDispatcher, type SessionSummary } from './host-runner.ts'
import { endpointEditorOps, endpointTimeoutPatches, readEndpointEditorState, readEndpointProviderCatalog, type EndpointEditorState } from './endpoint-editor.ts'
import {
  modelTimeoutOps,
  readModelTimeoutViews,
  type ModelTimeoutPatch,
  type ModelTimeoutSettingsSeam,
  type ModelTimeoutView,
} from './model-timeouts.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardSnapshot } from './protocol.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000
const HOUR_MS = 3_600_000

/** Host-local IANA time zone (the allowed-hours clock). */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The empty router config: no endpoints, no routing (today's direct behavior). */
function emptyRouterConfig(): EndpointRouterConfig {
  return { endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [] }
}

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  private readonly listeners = new Set<() => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastScheduleTick: number | undefined
  private disposed = false
  private pollInFlight = false
  private tickInFlight = false
  private routePassInFlight = false
  private routePassPending = false
  private active = true
  private preventIdleSleep = false
  private lastPowerJson = ''
  private routerConfig: EndpointRouterConfig = emptyRouterConfig()
  /** Execution ids with an in-flight launch; guards the queue re-check against double-launches. */
  private readonly launching = new Set<string>()
  private readonly now: () => number
  /** Host user-settings seam for the endpoint/timeout editor (absent = disabled). */
  private readonly settings: ModelTimeoutSettingsSeam | undefined

  constructor(api: ApiProxy, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    routerConfig?: EndpointRouterConfig
    settings?: ModelTimeoutSettingsSeam
  } = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger()
    this.runner = new HostExecutionRunner(api, options.commandDispatcher)
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    if (options.routerConfig !== undefined) this.routerConfig = options.routerConfig
    this.settings = options.settings
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
      this.emit()
      // Any ledger mutation can free a group slot (a member settled), open a
      // window (a schedule rolled), or change membership — re-check the queue
      // and group sequences. The pass is non-reentrant and cheap when idle.
      this.scheduleRoutePass()
    })
    this.power.subscribe(() => {
      // updateReasons emits on every poll tick even when nothing changed;
      // gate on the actual snapshot so the 5 s heartbeat does not push an
      // empty SSE frame per tab forever.
      const json = JSON.stringify(this.power.snapshot())
      if (json === this.lastPowerJson) return
      this.lastPowerJson = json
      this.emit()
    })
  }

  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.syncPowerReasons()
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.timers.push(setInterval(() => { this.scheduleTick(false) }, SCHEDULE_TICK_MS))
    this.schedulePoll()
    this.scheduleTick(true)
    this.scheduleRoutePass()
  }

  /** Replace the endpoint router configuration live (settings changed). */
  setEndpointConfig(config: EndpointRouterConfig): void {
    this.routerConfig = config
    if (this.active) this.scheduleRoutePass()
    this.emit()
  }

  setConfiguration(active: boolean, preventIdleSleep: boolean): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
    if (resumed) {
      const current = this.power.snapshot()
      this.power.updateReasons({
        runningSessions: current.runningSessions,
        armedSchedules: this.armedSchedules(),
        sessionStateKnown: false,
      })
    }
    this.power.setEnabled(active && preventIdleSleep)
    if (resumed) {
      this.schedulePoll()
      this.scheduleTick(true)
      this.scheduleRoutePass()
    }
    this.emit()
  }

  snapshot(): TaskBoardSnapshot {
    const state = this.ledger.state()
    return {
      schemaVersion: 2,
      revision: state.revision,
      tasks: state.tasks,
      groups: state.groups,
      workspaceDefaults: state.workspaceDefaults,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler, power: this.power.snapshot() }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: TaskBoardAction): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action)
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    // A stop/stop-group settles the ledger synchronously; the session cancel
    // RPC fires after so the agent actually halts (best-effort — a session
    // that is already gone is not an error).
    if (result.stopSessions !== undefined) {
      for (const sessionId of result.stopSessions) {
        void this.runner.cancel(sessionId).catch(error => {
          console.error('[dsh-task-board] session cancel failed', error)
        })
      }
    }
    return {
      schemaVersion: 2,
      revision: result.state.revision,
      tasks: result.state.tasks,
      groups: result.state.groups,
      workspaceDefaults: result.state.workspaceDefaults,
      scheduler: result.state.scheduler,
      power: this.power.snapshot(),
    }
  }

  /**
   * Current effective model default timeouts, one row per provider route.
   * Empty when no settings seam is wired (the routes then report no rows and
   * refuse writes).
   */
  modelTimeouts(): ModelTimeoutView[] {
    const settings = this.settings
    if (settings === undefined) return []
    return readModelTimeoutViews(settings.get('llm-pi-ai'), settings.get('llm-deepseek'))
  }

  /**
   * Apply one provider's model default-timeout patch through the settings
   * seam. The write validates against the provider's own schema (a rejected
   * value refuses rather than storing), then the row is re-read so the caller
   * gets the effective value after the change.
   * @param patch - the provider and desired timeout state.
   * @returns the provider's updated effective view.
   */
  async applyModelTimeout(patch: ModelTimeoutPatch): Promise<ModelTimeoutView> {
    const settings = this.settings
    if (settings === undefined) throw new Error('settings service is unavailable')
    const target = this.modelTimeouts().find(view => view.provider === patch.provider)
    if (target === undefined) throw new Error(`model provider not found: ${patch.provider}`)
    const { namespace, ops } = modelTimeoutOps(target, patch)
    await settings.mutate(namespace, ops)
    const updated = this.modelTimeouts().find(view => view.provider === patch.provider)
    if (updated === undefined) throw new Error(`model provider not found after update: ${patch.provider}`)
    return updated
  }

  /**
   * The current endpoint editor state over the `task-board` namespace: the
   * configured endpoints (with per-endpoint timeouts resolved from the
   * provider route settings) plus the global default order. Empty when no
   * settings seam is wired.
   */
  endpoints(): EndpointEditorState {
    const settings = this.settings
    if (settings === undefined) return { endpoints: [], defaultEndpoints: [] }
    return readEndpointEditorState(settings.get('task-board'), this.modelTimeouts())
  }

  /** The provider catalog the endpoint editor offers (routes + their models and timeouts). */
  endpointProviders(): ReturnType<typeof readEndpointProviderCatalog> {
    const settings = this.settings
    if (settings === undefined) return []
    return readEndpointProviderCatalog(settings.get('llm-pi-ai'), settings.get('llm-deepseek'))
  }

  /**
   * Store one endpoint editor state through the settings seam: the endpoint
   * list lands in the `task-board` namespace and each endpoint's idle/total
   * timeouts write through to its provider route's settings (the only place
   * DSH honors them). The writes are validated by the respective schemas,
   * then the state is re-read so the caller gets the effective list after the
   * change. The namespace's change hook reloads the router live and the
   * browser mirror refreshes the task modal's endpoint dropdown.
   * @param state - the validated full editor state.
   * @returns the stored effective editor state.
   */
  async applyEndpoints(state: EndpointEditorState): Promise<EndpointEditorState> {
    const settings = this.settings
    if (settings === undefined) throw new Error('settings service is unavailable')
    await settings.mutate('task-board', endpointEditorOps(state))
    const catalog = this.endpointProviders()
    for (const patch of endpointTimeoutPatches(state, catalog)) {
      const target = this.modelTimeouts().find(view => view.provider === patch.provider)
      if (target === undefined) continue
      const { namespace, ops } = modelTimeoutOps(target, {
        provider: patch.provider,
        streamIdleTimeoutMs: patch.streamIdleTimeoutMs,
        ...(patch.timeoutMs === undefined ? {} : { timeoutMs: patch.timeoutMs }),
      })
      await settings.mutate(namespace, ops)
    }
    return readEndpointEditorState(settings.get('task-board'), this.modelTimeouts())
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.launching.clear()
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  /**
   * Route one freshly opened run through the group gates and the endpoint
   * router: launch through the first eligible endpoint, queue it (no session,
   * nothing billed) when a group slot, the group window, or every endpoint
   * blocks, or launch directly when no endpoints are configured at all.
   */
  private async launchRouted(opened: OpenedRun): Promise<void> {
    if (this.launching.has(opened.execution.id)) return
    this.launching.add(opened.execution.id)
    try {
      const route = this.routeFor(opened.task)
      if (route.mode === 'wait') {
        this.ledger.markQueued(opened.task.id, opened.execution.id, route.endpointId, this.now(), route.reason ?? 'endpoint')
        return
      }
      if (route.mode === 'routed') {
        this.ledger.attachEndpoint(opened.task.id, opened.execution.id, route.endpoint.id)
      }
      await this.launch(opened.task, opened.execution.id, route.mode === 'routed' ? route.selection : undefined)
    } finally {
      this.launching.delete(opened.execution.id)
    }
  }

  /**
   * Re-check queued runs (a group slot, the group window, or an endpoint may
   * have opened): expire them, or launch the moment the run becomes eligible.
   * Runs once per poll/tick; a pass never re-enters.
   */
  private async routeQueued(): Promise<void> {
    if (this.disposed || !this.active) return
    const now = this.now()
    const maxWaitMs = this.routerConfig.endpointMaxWaitHours * HOUR_MS
    for (const queued of this.ledger.queuedRuns()) {
      // The task may have been unapproved while the run waited for an
      // endpoint/slot/window; an unapproved task can never run, so the held
      // run is cancelled (it lands in failed, like any stop).
      if (queued.task.approved === false) {
        this.ledger.settle(queued.taskId, queued.executionId, 'cancelled', 'task is not approved')
        continue
      }
      if (now - queued.queuedAt > maxWaitMs) {
        this.ledger.settle(queued.taskId, queued.executionId, 'failed', 'run never became eligible to launch within the max-wait window')
        continue
      }
      if (this.launching.has(queued.executionId)) continue
      const route = this.routeFor(queued.task)
      if (route.mode === 'wait') {
        const reason = route.reason ?? 'endpoint'
        const endpointId = route.endpointId
        if (reason !== queued.queuedReason || endpointId !== queued.endpointId) {
          this.ledger.requeue(queued.taskId, queued.executionId, endpointId, reason)
        }
        continue
      }
      this.launching.add(queued.executionId)
      try {
        if (route.mode === 'routed') {
          this.ledger.attachEndpoint(queued.taskId, queued.executionId, route.endpoint.id)
        }
        await this.launch(queued.task, queued.executionId, route.mode === 'routed' ? route.selection : undefined)
      } finally {
        this.launching.delete(queued.executionId)
      }
    }
  }

  /** The routing decision for one task: group gates first, then endpoints. */
  private routeFor(task: OpenedRun['task']): RouteDecision {
    const config = this.routerConfig
    const group = task.groupId === undefined ? undefined : this.ledger.groupById(task.groupId)
    // A task's own pin wins, then the group's list, then the workspace's
    // default list, then the global default list (an empty effective list =
    // no routing). The workspace defaults also fill a blank model pin so the
    // router checks the workspace-default model against endpoint eligibility.
    const defaults = task.workspaceId === undefined ? undefined : this.ledger.workspaceDefaultsFor(task.workspaceId)
    const effective = {
      ...task,
      ...(task.model === undefined && defaults?.model !== undefined ? { model: defaults.model } : {}),
      endpoints: effectiveEndpointIds(task, group, defaults?.endpoints),
    }
    // The group gates (capacity, window) apply to every member launch even
    // when no endpoints are configured at all — only a group-less task with
    // no routing list bypasses the router entirely.
    if (group === undefined && !shouldUseRouter(effective, config)) return { mode: 'unrouted' }
    const now = new Date(this.now())
    const localMinutes = clockMinutesInTimeZone(now, hostTimeZone())
    if (group !== undefined) {
      // A stopped group launches nothing (defensive: manual runs, crons, and
      // queued runs are all refused/cancelled upstream, but a stale queued run
      // must never slip through).
      if (group.stopped === true) {
        return { mode: 'wait', endpointId: effective.endpoints?.[0], reasons: [], reason: 'group' }
      }
      if (groupCapacityFull(group, this.groupLaunchedCount(group.id))) {
        return { mode: 'wait', endpointId: effective.endpoints?.[0], reasons: [], reason: 'group' }
      }
      if (!groupWindowOpen(group, localMinutes, now)) {
        return { mode: 'wait', endpointId: effective.endpoints?.[0], reasons: [], reason: 'window' }
      }
    }
    return pickEndpoint(effective, config)
  }

  /**
   * Advance group sequences: after a member settles (or a group cron fires),
   * start the next runnable member(s) in group order, respecting the group's
   * capacity, window, and endpoint eligibility. A group advances only when a
   * slot actually freed — its newest member execution settled — or its cron is
   * armed, so idle groups are never started spontaneously and manual launches
   * are never raced by the chain. Queued (manually requested) members take
   * priority over auto-advance.
   */
  private advanceGroups(): void {
    if (this.disposed || !this.active) return
    const now = new Date(this.now())
    const config = this.routerConfig
    const localMinutes = clockMinutesInTimeZone(now, hostTimeZone())
    for (const view of this.ledger.groupRuntimeViews()) {
      // Triggers: an armed group schedule, or a settled member freeing a slot.
      if (!view.scheduleEnabled && !view.newestExecutionSettled) continue
      // A stopped group launches nothing; resume clears the flag.
      if (view.stopped) continue
      // A queued member is waiting for a slot/window/endpoint; it holds the
      // sequence's place — never start another member over it.
      if (view.members.some(member => member.queued)) continue
      if (!groupWindowOpen(view, localMinutes, now)) continue
      const group = this.ledger.groupById(view.id)
      if (group === undefined) continue
      let launched = view.members.filter(member => member.launched).length
      for (const member of view.members) {
        if (!member.runnable) continue
        if (groupCapacityFull(group, launched)) break
        const task = this.ledger.taskById(member.taskId)
        if (task === undefined) continue
        const decision = this.routeFor(task)
        // Auto-advance never queues: a member that cannot launch now is left
        // in place and the next pass (tick/settle/config) retries it.
        if (decision.mode === 'wait') continue
        const opened = this.ledger.openExecution(member.taskId, now.getTime())
        if (opened === undefined) continue
        launched += 1
        if (decision.mode === 'routed') {
          this.ledger.attachEndpoint(opened.task.id, opened.execution.id, decision.endpoint.id)
        }
        this.launching.add(opened.execution.id)
        void this.launch(opened.task, opened.execution.id, decision.mode === 'routed' ? decision.selection : undefined)
          .catch(error => {
            console.error('[dsh-task-board] group advance launch failed', error)
          })
          .finally(() => { this.launching.delete(opened.execution.id) })
      }
    }
  }

  /** Launched-and-unsettled executions of one group's members (capacity accounting). */
  private groupLaunchedCount(groupId: string): number {
    let count = 0
    for (const execution of this.ledger.runtimeView().openExecutions) {
      if (execution.sessionId === undefined || execution.groupId !== groupId) continue
      count += 1
    }
    return count
  }

  private scheduleRoutePass(): void {
    if (this.disposed) return
    // The queue re-check is async and only clears its in-flight flag in a
    // microtask, so a synchronous burst of ledger commits (several actions in
    // one tick) would otherwise drop every pass after the first. Coalesce:
    // mark a pass pending and re-run once the current one settles.
    if (this.routePassInFlight) {
      this.routePassPending = true
      return
    }
    this.routePassInFlight = true
    this.routePassPending = false
    void this.routeQueued().catch(error => {
      console.error('[dsh-task-board] endpoint queue re-check failed', error)
    }).finally(() => {
      this.routePassInFlight = false
      if (this.routePassPending) this.scheduleRoutePass()
    })
    // Group sequences advance on the same pass (after the queued runs — a
    // queued manual run has priority over auto-advance).
    this.advanceGroups()
  }

  private async launch(task: TaskRecord, executionId: string, route?: { provider: string; model: string; reasoningEffort?: string }): Promise<void> {
    try {
      const sessionId = await this.runner.launch(this.withWorkspaceDefaults(task), route)
      this.ledger.attachSession(task.id, executionId, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(task.id, executionId, error.sessionId)
      }
      this.ledger.settle(task.id, executionId, 'failed', error instanceof Error ? error.message : String(error))
    } finally {
      // A slot just freed (or a launch failed): re-check anyone still queued.
      this.scheduleRoutePass()
    }
  }

  /**
   * The task view the runner composes: the task's own execution targets when
   * set, otherwise the workspace defaults. The workspace defaults fill blank
   * mode/model/permission (endpoints were already resolved by the router, so
   * they are not read back here). A task with no workspace, or a workspace
   * without defaults, passes through unchanged.
   */
  private withWorkspaceDefaults(task: TaskRecord): TaskRecord {
    if (task.workspaceId === undefined) return task
    const defaults = this.ledger.workspaceDefaultsFor(task.workspaceId)
    if (defaults === undefined) return task
    return { ...task, ...resolveExecutionTargets(task, defaults) }
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    if (!this.active && this.ledger.runtimeView().openExecutions.length === 0) return
    const running = await this.runner.listRunning()
    const previous = this.power.snapshot()
    if (!running.known) {
      this.power.updateReasons({
        runningSessions: previous.runningSessions,
        armedSchedules: this.ledger.armedScheduleCount(),
        sessionStateKnown: false,
      })
      return
    }
    // Read after the RPC so executions attached while it was in flight are
    // included in this pass, matching the former full-state snapshot timing.
    const runtime = this.ledger.runtimeView()
    this.power.updateReasons({
      runningSessions: running.count,
      armedSchedules: runtime.armedSchedules,
      sessionStateKnown: true,
    })
    // No unconditional emit here: real changes already emit through the
    // ledger subscription (settles) and the gated power listener above.
    await this.reconcileExecutions(running.items, runtime.openExecutions)
  }

  /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
  private async reconcileExecutions(
    sessions: readonly SessionSummary[],
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    for (const execution of executions) {
      if (execution.sessionId === undefined) continue
      try {
        const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions)
        if (result.outcome === 'pending') continue
        this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
      } catch {
        // A transient inspection failure never settles a running execution.
      }
    }
  }

  private async tickSchedule(first: boolean): Promise<void> {
    if (this.disposed || !this.active) return
    const now = this.now()
    const recovered = first || (this.lastScheduleTick !== undefined && now - this.lastScheduleTick > RESUME_GAP_MS)
    this.lastScheduleTick = now
    this.ledger.setScheduler({ lastTickAt: now })
    if (recovered) {
      this.ledger.skipMissed(now)
      return
    }
    for (const schedule of this.ledger.dueSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
      const opened = this.ledger.openScheduled(schedule.taskId, next, now)
      if (opened !== undefined) this.scheduleLaunch(opened)
    }
    // A due group schedule fires the group sequence: roll the rule forward and
    // let the route pass advance the next runnable member(s).
    for (const schedule of this.ledger.dueGroupSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
      this.ledger.rollGroupSchedule(schedule.groupId, next, now)
      this.scheduleRoutePass()
    }
  }

  private armedSchedules(): number {
    return this.ledger.armedScheduleCount()
  }

  private scheduleLaunch(opened: OpenedRun): void {
    void this.launchRouted(opened).catch(error => {
      console.error('[dsh-task-board] execution launch settlement failed', error)
    })
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      console.error('[dsh-task-board] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  private scheduleTick(first: boolean): void {
    if (this.tickInFlight || this.disposed) return
    this.tickInFlight = true
    void this.tickSchedule(first).catch(error => {
      console.error('[dsh-task-board] scheduler tick failed', error)
    }).finally(() => { this.tickInFlight = false })
  }

  private syncPowerReasons(): void {
    const current = this.power.snapshot()
    this.power.updateReasons({
      runningSessions: current.runningSessions,
      armedSchedules: this.armedSchedules(),
      sessionStateKnown: current.sessionStateKnown,
    })
    this.power.setEnabled(this.active && this.preventIdleSleep)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
