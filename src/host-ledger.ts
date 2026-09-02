import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { isValidCron, nextRunAtMs } from './core/schedule.ts'
import {
  applyCreateGroup,
  applyDeleteGroup,
  applyUpdateGroup,
  GROUP_FIELD_BOUND,
  groupFinalStepBlocked,
  groupFinalStepReady,
  groupSequenceStarted,
  normalizeGroupOrder,
  normalizeGroupRows,
  taskMatchesGroupScope,
  withGroupMembershipChange,
  withGroupOrder,
  withGroupScheduleRoll,
  type GroupExecutionMode,
  type GroupUpdatePatch,
  type TaskGroupRecord,
} from './core/groups.ts'
import { parseLedger } from './core/store.ts'
import { canMoveManually, continueExecution, MANUAL_STATUSES, moveTaskBefore, pauseExecution, retainRecentExecutions, settleExecution, startExecution, withStatus, type ExecutionRecord, type ExecutionUsage, type TaskRecord } from './core/tasks.ts'
import { applyArchiveTask, applyArchiveTasks, applyRestoreTask, collectExecutionSessionIds } from './core/use-cases/task-archive.ts'
import { applyCreateTask } from './core/use-cases/task-create.ts'
import { applyDeleteTask } from './core/use-cases/task-delete.ts'
import { applySetSchedule, applyScheduleNextRun } from './core/use-cases/task-schedule.ts'
import { applyUpdateTask, canEditTaskContent, hasContentPatch } from './core/use-cases/task-update.ts'
import { applyWorkspaceDefaultsPatch, normalizeWorkspaceDefaults, type WorkspaceDefaultsPatch, type WorkspaceDefaultsRecord } from './core/workspace-defaults.ts'
import { ALL_TASKS_SCHEMA_VERSION, type AllTasksAction, type AllTasksSchedulerSnapshot } from './protocol.ts'

interface PersistedScheduler extends AllTasksSchedulerSnapshot {
  importedSources?: string[]
}

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

interface LedgerDocument {
  schemaVersion: typeof ALL_TASKS_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  /** Task groups (named member sets with shared execution policy). */
  groups: TaskGroupRecord[]
  /**
   * Per-workspace execution defaults for new tasks, keyed by workspace-list
   * id. Only non-empty records are stored (an all-blank edit removes the
   * entry); absent records mean the runtime defaults apply.
   */
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>
  /**
   * When each workspace was paused (ms epoch), keyed by workspace-list id;
   * the empty string key means the whole board. While a workspace is paused
   * its tasks launch nothing and open executions stay halted until the
   * workspace is continued. Only explicitly paused workspaces are stored.
   */
  workspacePaused: Record<string, number>
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
}

export interface LedgerState {
  revision: number
  tasks: TaskRecord[]
  groups: TaskGroupRecord[]
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>
  workspacePaused: Record<string, number>
  scheduler: AllTasksSchedulerSnapshot
}

/** One execution settlement, emitted once the outcome is durably recorded. */
export interface SettlementEvent {
  taskId: string
  executionId: string
  outcome: 'succeeded' | 'failed' | 'cancelled'
  error?: string
  summary?: string
  usage?: ExecutionUsage
  sessionId?: string
}

export interface OpenedRun {
  task: TaskRecord
  execution: ExecutionRecord
}

/** One session to re-prompt after a `continue` action (the execution stays open). */
export interface ResumeRun {
  sessionId: string
  /** The continued task (its prompt is re-sent to the same session). */
  task: TaskRecord
}

/** The side effects one action request hands to the Host service. */
export interface LedgerApplyResult {
  state: LedgerState
  run?: OpenedRun
  runs?: OpenedRun[]
  /** Sessions whose active turn must be cancelled (stop / pause actions). */
  stopSessions?: string[]
  /** Sessions to re-prompt with their task (continue actions). */
  resumeRuns?: ResumeRun[]
  /**
   * Execution sessions of tasks a hide-tasks action archived, to be hidden
   * from the DSH session list (the workspace registry's archive set). The
   * Host derives them from the ledger executions it just archived; best-effort
   * fire-and-forget like session cancel.
   */
  archiveSessions?: string[]
}

/** Minimal value copy used by the Host session monitor. */
export interface OpenExecutionReference {
  readonly taskId: string
  readonly executionId: string
  readonly sessionId: string | undefined
  readonly startedAt: number
  /** When the session was attached (the real launch instant; see ExecutionRecord.launchedAt). */
  readonly launchedAt: number | undefined
  /** Group the task belongs to (for capacity accounting). */
  readonly groupId?: string
  /** Endpoint this run is routed through (set while queued or once launched). */
  readonly endpointId?: string
  /** Set while the router is holding this run for an eligible endpoint. */
  readonly queuedAt?: number
  /** Set while the run is paused (the monitor never settles it). */
  readonly pausedAt?: number
  /** Observation boundary: the monitor ignores turn/end events before it. */
  readonly watchFromAt?: number
}

/** An open execution the router is holding for an eligible endpoint. */
export interface QueuedRunReference {
  readonly taskId: string
  readonly executionId: string
  readonly queuedAt: number
  /** Why the run is held (endpoint eligibility, group slot, group window, or a paused workspace). */
  readonly queuedReason?: 'endpoint' | 'group' | 'window' | 'workspace'
  /** Preferred endpoint while waiting (the first known candidate). */
  readonly endpointId?: string
  /** Set while the run is paused (the router never launches it). */
  readonly pausedAt?: number
  /** Task clone (read-only view; the router reads pins only). */
  readonly task: TaskRecord
}

/** Minimal value copy used by the Host scheduler. */
export interface DueScheduleReference {
  readonly taskId: string
  readonly cron: string
  readonly nextRunAt: number
}

/** A due group schedule (the group cron fires the group sequence). */
export interface DueGroupScheduleReference {
  readonly groupId: string
  readonly cron: string
  readonly nextRunAt: number
}

/** One member's runtime facts for group capacity/advance decisions. */
export interface GroupMemberRuntimeView {
  readonly taskId: string
  /** backlog/todo, on-board, and no open execution (may auto-start). */
  readonly runnable: boolean
  /** Has an open launched execution (holds a capacity slot). */
  readonly launched: boolean
  /** Has an open queued execution (waits; takes priority over auto-advance). */
  readonly queued: boolean
  /** Has at least one execution record ever (the group sequence has started). */
  readonly hasRun: boolean
}

/** Runtime-only projection of one group for the router's advance pass. */
export interface GroupRuntimeView {
  readonly id: string
  readonly mode: GroupExecutionMode
  readonly maxParallel?: number
  readonly allowedHours?: { start: string; end: string }
  readonly offPeakOnly: boolean
  /** Whether the group is stopped (no member launches until resumed). */
  readonly stopped: boolean
  /** Whether the group is paused (member sessions halted, no launches until continued). */
  readonly paused: boolean
  /** Whether the group's own cron is armed. */
  readonly scheduleEnabled: boolean
  /**
   * Whether the group's newest member execution is settled. The auto-advance
   * pass only starts further members when a slot actually freed (a member
   * settled) or the group cron is armed — never while a member is merely
   * running, so manual launches are never raced by the chain.
   */
  readonly newestExecutionSettled: boolean
  /** The group's final-step member id, when one is designated. */
  readonly finalStepTaskId?: string
  /**
   * Whether the group's final step may launch right now (every other member
   * settled and the final step itself runnable — see {@link groupFinalStepReady}).
   * The advance pass starts it only when this is true.
   */
  readonly finalStepReady: boolean
  readonly order: readonly string[]
  readonly members: readonly GroupMemberRuntimeView[]
}

/** Derived runtime data for one session-poll pass. */
export interface LedgerRuntimeView {
  readonly armedSchedules: number
  readonly openExecutions: readonly OpenExecutionReference[]
}

const MAX_REQUEST_CACHE = 256

interface CachedRequest {
  fingerprint: string
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

function cloneGroups(groups: readonly TaskGroupRecord[]): TaskGroupRecord[] {
  return JSON.parse(JSON.stringify(groups)) as TaskGroupRecord[]
}

function cloneWorkspaceDefaults(defaults: Record<string, WorkspaceDefaultsRecord>): Record<string, WorkspaceDefaultsRecord> {
  return JSON.parse(JSON.stringify(defaults)) as Record<string, WorkspaceDefaultsRecord>
}

function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

/**
 * Load and normalize the persisted per-workspace pause map: finite-number
 * values are kept, everything else is dropped; a non-object payload collapses
 * to empty. The empty-string key (the whole board) is kept like any other.
 */
function normalizeWorkspacePaused(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, pausedAt] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > GROUP_FIELD_BOUND) continue
    if (typeof pausedAt === 'number' && Number.isFinite(pausedAt)) result[key] = pausedAt
  }
  return result
}

/**
 * Process states that are dead but still occupy the PID table: `Z` (zombie)
 * and `X` (dead, being reaped). `process.kill(pid, 0)` reports such PIDs as
 * alive, so a crash leftover whose child was never reaped would otherwise be
 * mistaken for a live owner and block ledger startup forever.
 */
const DEAD_STATES = new Set(['Z', 'X'])

/**
 * Best-effort single-letter process state ('R','S','D','Z',...) or undefined
 * when no probe is available on this platform. Linux reads /proc/<pid>/stat
 * directly (no subprocess); other POSIX shells out to `ps -o stat=`; Windows
 * has no zombie state, so it returns undefined and the kill(0) probe alone
 * is authoritative there.
 */
export function processState(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      if (end === -1) return undefined
      return stat.slice(end + 2).split(' ')[0] || undefined
    } catch {
      return undefined // no such process (or unreadable)
    }
  }
  if (process.platform === 'win32') return undefined
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS })
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const state = probe.stdout.toString('utf8').trim()
    return state.length > 0 ? state[0] : undefined
  } catch {
    return undefined
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const state = processState(pid)
  if (state !== undefined && DEAD_STATES.has(state)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const PROCESS_PROBE_TIMEOUT_MS = 3000

let ownStartTime: number | undefined
let ownStartTimeResolved = false

/**
 * Exact process start time (Unix epoch ms) on Linux, read straight from
 * /proc (field 22 = start ticks since boot, btime = boot epoch seconds).
 * No subprocess and no rounding, so the recorded `startedAt` from a previous
 * boot compares exactly against the live process identity.
 */
function linuxStartTimeMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end === -1) return undefined
    const ticks = Number(stat.slice(end + 2).split(' ')[19])
    if (!Number.isFinite(ticks)) return undefined
    const bootMatch = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))
    if (bootMatch === null) return undefined
    const btime = Number(bootMatch[1])
    if (!Number.isFinite(btime)) return undefined
    return btime * 1000 + (ticks * 1000) / 100 // USER_HZ is 100 on Linux
  } catch {
    return undefined
  }
}

/**
 * Best-effort start time (Unix epoch ms) of a live process. Used to prove
 * whether the ledger lock really belongs to the PID recorded in it, so a
 * crash leftover whose PID was reused by an unrelated process (issue #786)
 * is detected as stale instead of blocking startup forever. Returns
 * undefined when the platform probe is unavailable; callers fail closed.
 */
function processStartTimeMs(pid: number): number | undefined {
  if (process.platform === 'linux') return linuxStartTimeMs(pid)
  if (process.platform === 'win32') {
    const probe = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[DateTimeOffset]::FromFileTime((Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToFileTime()).ToUnixTimeMilliseconds()'],
      { timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true },
    )
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const started = Number(probe.stdout.toString('utf8').trim())
    return Number.isFinite(started) ? started : undefined
  }
  // Other POSIX (macOS...): ps lstart with a forced English locale, falling
  // back to the elapsed-seconds column when lstart cannot be parsed.
  const env = { ...process.env, LC_ALL: 'C' }
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (probe.status === 0 && probe.stdout.length > 0) {
    const started = Date.parse(probe.stdout.toString('utf8').trim())
    if (Number.isFinite(started)) return started
  }
  const elapsed = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (elapsed.status !== 0 || elapsed.stdout.length === 0) return undefined
  const seconds = Number(elapsed.stdout.toString('utf8').trim())
  if (!Number.isFinite(seconds)) return undefined
  return Date.now() - seconds * 1000
}

function ownProcessStartTimeMs(): number | undefined {
  if (!ownStartTimeResolved) {
    ownStartTimeResolved = true
    ownStartTime = processStartTimeMs(process.pid)
  }
  return ownStartTime
}

/**
 * Bounded tolerance for legacy lock records. Locks written before the
 * ms-precise probe recorded `startedAt` from `ps -o lstart=` at whole-second
 * resolution; probing the SAME live process exactly (via /proc) then differs
 * in the sub-second remainder. Treating that as PID reuse would steal a live
 * owner's lock during a rolling upgrade and start a second ledger writer.
 * Records written by the ms-precise probe carry `probe: 'exact'` and are
 * compared strictly; anything else (older locks, second-granularity probes)
 * falls back to this bounded tolerance.
 */
const LEGACY_START_TOLERANCE_MS = 2000

/** Whether the recorded start time proves the recorded PID is another process. */
function startTimeMismatch(recorded: number, actual: number, exact: boolean): boolean {
  return exact ? recorded !== actual : Math.abs(recorded - actual) > LEGACY_START_TOLERANCE_MS
}

function betterExecution(a: ExecutionRecord, b: ExecutionRecord): ExecutionRecord {
  if (a.endedAt === undefined && b.endedAt !== undefined) return b
  if (b.endedAt === undefined && a.endedAt !== undefined) return a
  return (b.endedAt ?? b.startedAt) >= (a.endedAt ?? a.startedAt) ? b : a
}

function mergeTask(a: TaskRecord, b: TaskRecord): TaskRecord {
  // Existing Host state wins ties so an equally old browser backup cannot
  // roll authoritative fields back during multi-browser v1 migration.
  const newer = b.updatedAt > a.updatedAt ? b : a
  const byId = new Map<string, ExecutionRecord>()
  for (const entry of [...a.executions, ...b.executions]) {
    const previous = byId.get(entry.id)
    byId.set(entry.id, previous === undefined ? entry : betterExecution(previous, entry))
  }
  const executions = [...byId.values()].sort((x, y) => x.startedAt - y.startedAt)
  return { ...newer, executions: retainRecentExecutions(executions) }
}

function parseHostTasks(values: readonly unknown[]): TaskRecord[] {
  const rawById = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id === 'string') rawById.set(raw.id, raw)
  }
  return parseLedger(JSON.stringify(values)).map(task => {
    const rawSchedule = rawById.get(task.id)?.schedule
    if (typeof rawSchedule !== 'object' || rawSchedule === null) return task
    const schedule = rawSchedule as Record<string, unknown>
    if (typeof schedule.cron !== 'string' || isValidCron(schedule.cron)) return task
    return {
      ...task,
      schedule: {
        enabled: false,
        cron: schedule.cron,
        nextRunAt: undefined,
        lastTriggeredAt: typeof schedule.lastTriggeredAt === 'number' && Number.isFinite(schedule.lastTriggeredAt)
          ? schedule.lastTriggeredAt
          : undefined,
      },
    }
  })
}

/**
 * Load and normalize the persisted per-workspace defaults map: invalid
 * entries are dropped, never stored; a non-object payload collapses to empty.
 */
function normalizeWorkspaceDefaultsMap(value: unknown): Record<string, WorkspaceDefaultsRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, WorkspaceDefaultsRecord> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const record = normalizeWorkspaceDefaults(raw)
    if (record === undefined) continue
    result[key] = record
  }
  return result
}

export class HostTaskLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly settledListeners = new Set<(event: SettlementEvent) => void>()
  private readonly requestCache = new Map<string, CachedRequest>()
  private readonly lockToken = crypto.randomUUID()
  private lockFd: number | undefined
  readonly file: string
  readonly lockFile: string
  /** Small sidecar for the 30 s scheduler heartbeat (lastTickAt only). */
  readonly schedulerFile: string

  constructor(dir: string = join(dshHome(), 'all-tasks'), private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'ledger-v2.json')
    this.lockFile = join(dir, 'ledger-v2.lock')
    this.schedulerFile = join(dir, 'scheduler-v2.json')
    this.lockFd = this.acquireLock()
    try {
      this.document = this.load(dir)
      for (const request of this.document.recentRequests) {
        this.requestCache.set(request.requestId, { fingerprint: request.fingerprint })
      }
      this.repairSchedules(true)
      this.reconcileInterruptedStarts()
      // Persist a freshly generated ledger identity and any recovery error
      // immediately, even when there are no tasks to trigger a later action.
      this.commit(false)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Revision + scheduler without any task cloning; feeds the SSE event frame. */
  summary(): { revision: number; scheduler: AllTasksSchedulerSnapshot } {
    const { importedSources: _imports, ...scheduler } = this.document.scheduler
    return { revision: this.document.revision, scheduler: { ...scheduler } }
  }

  state(): LedgerState {
    const { revision, scheduler } = this.summary()
    return {
      revision,
      tasks: cloneTasks(this.document.tasks),
      groups: cloneGroups(this.document.groups),
      workspaceDefaults: cloneWorkspaceDefaults(this.document.workspaceDefaults),
      workspacePaused: { ...this.document.workspacePaused },
      scheduler,
    }
  }

  /** Deep copy of one group (read-only view; never the authoritative object). */
  groupById(id: string): TaskGroupRecord | undefined {
    const group = this.document.groups.find(candidate => candidate.id === id)
    return group === undefined ? undefined : cloneGroups([group])[0]
  }

  /** Deep copy of one task (read-only view; never the authoritative object). */
  taskById(id: string): TaskRecord | undefined {
    const task = this.document.tasks.find(candidate => candidate.id === id)
    return task === undefined ? undefined : cloneTasks([task])[0]
  }

  /** Deep copy of one workspace's execution defaults (read-only view). */
  workspaceDefaultsFor(workspaceId: string): WorkspaceDefaultsRecord | undefined {
    const record = this.document.workspaceDefaults[workspaceId]
    return record === undefined ? undefined : cloneWorkspaceDefaults({ [workspaceId]: record })[workspaceId]
  }

  /**
   * Whether a task's workspace is paused: its own workspace id, or the whole
   * board (the empty-string key) which covers every task including unassigned
   * ones. While paused the task launches nothing by any means.
   */
  workspacePausedFor(task: { workspaceId?: string }): boolean {
    return this.document.workspacePaused[task.workspaceId ?? ''] !== undefined
      || this.document.workspacePaused[''] !== undefined
  }

  /** Whether one open execution is paused (halted but resumable). */
  executionPaused(taskId: string, executionId: string): boolean {
    const task = this.document.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) return false
    return task.executions.some(entry => entry.id === executionId && entry.endedAt === undefined && entry.pausedAt !== undefined)
  }

  /**
   * Runtime-only projection for the 5 s Host poll. It copies just primitive
   * identifiers and timestamps, never the complete task/execution history or
   * an authoritative mutable object from the ledger.
   */
  runtimeView(): LedgerRuntimeView {
    let armedSchedules = 0
    const openExecutions: OpenExecutionReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) armedSchedules += 1
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined) continue
        openExecutions.push({
          taskId: task.id,
          executionId: execution.id,
          sessionId: execution.sessionId,
          startedAt: execution.startedAt,
          launchedAt: execution.launchedAt,
          ...(task.groupId === undefined ? {} : { groupId: task.groupId }),
          ...(execution.endpointId === undefined ? {} : { endpointId: execution.endpointId }),
          ...(execution.queuedAt === undefined ? {} : { queuedAt: execution.queuedAt }),
          ...(execution.pausedAt === undefined ? {} : { pausedAt: execution.pausedAt }),
          ...(execution.watchFromAt === undefined ? {} : { watchFromAt: execution.watchFromAt }),
        })
      }
    }
    return { armedSchedules, openExecutions }
  }

  /** Open executions the router is holding (queued, no session yet), with task clones. */
  queuedRuns(): QueuedRunReference[] {
    const queued: QueuedRunReference[] = []
    for (const task of this.document.tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined || execution.sessionId !== undefined || execution.queuedAt === undefined) continue
        queued.push({
          taskId: task.id,
          executionId: execution.id,
          queuedAt: execution.queuedAt,
          ...(execution.queuedReason === undefined ? {} : { queuedReason: execution.queuedReason }),
          ...(execution.endpointId === undefined ? {} : { endpointId: execution.endpointId }),
          ...(execution.pausedAt === undefined ? {} : { pausedAt: execution.pausedAt }),
          task: cloneTasks([task])[0],
        })
      }
    }
    return queued
  }

  /**
   * Record that a run is queued for an eligible endpoint: no session is
   * created yet, so nothing is billed, and the run survives Host restarts.
   */
  markQueued(taskId: string, executionId: string, endpointId: string | undefined, queuedAt: number, reason?: 'endpoint' | 'group' | 'window' | 'workspace'): void {
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: this.now(),
      executions: task.executions.map(entry => entry.id !== executionId ? entry : {
        ...entry,
        queuedAt,
        ...(endpointId === undefined ? {} : { endpointId }),
        ...(reason === undefined ? {} : { queuedReason: reason }),
      }),
    })
    this.commit()
  }

  /**
   * Refresh why a queued run is still held (its preferred endpoint and/or the
   * blocking reason changed while waiting). The original queuedAt is kept so
   * the max-wait window is measured from the first queue, not the last retry.
   */
  requeue(taskId: string, executionId: string, endpointId: string | undefined, reason: 'endpoint' | 'group' | 'window' | 'workspace' | undefined): void {
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: this.now(),
      executions: task.executions.map(entry => entry.id !== executionId ? entry : {
        ...entry,
        ...(endpointId === undefined ? {} : { endpointId }),
        ...(reason === undefined ? {} : { queuedReason: reason }),
      }),
    })
    this.commit()
  }

  /**
   * Runtime-only projection of every group for the router's advance pass:
   * per-member runnable/launched/queued/has-run facts, no execution history.
   */
  groupRuntimeViews(): GroupRuntimeView[] {
    const openByTask = new Map<string, { launched: boolean; queued: boolean }>()
    for (const task of this.document.tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined) continue
        const entry = openByTask.get(task.id) ?? { launched: false, queued: false }
        if (execution.sessionId === undefined) entry.queued = true
        else entry.launched = true
        openByTask.set(task.id, entry)
      }
    }
    return this.document.groups.map(group => {
      const members: GroupMemberRuntimeView[] = []
      let newest: { startedAt: number; endedAt: number | undefined } | undefined
      for (const id of group.order) {
        const task = this.document.tasks.find(candidate => candidate.id === id)
        if (task === undefined) continue
        const open = openByTask.get(task.id)
        members.push({
          taskId: task.id,
          // A held member (deferAutoStart) joined the group after its
          // sequence started; the auto-advance chain skips it until an
          // explicit start (run-group / group cron / manual run) clears it.
          // The group's final step is never chain-runnable either: it opens
          // only through its own gate (finalStepReady).
          runnable: task.id !== group.finalStepTaskId
            && task.archivedAt === undefined
            && task.approved !== false
            && task.deferAutoStart !== true
            && (task.status === 'backlog' || task.status === 'todo')
            && !this.workspacePausedFor(task)
            && open === undefined,
          launched: open?.launched === true,
          queued: open?.queued === true,
          hasRun: task.executions.length > 0,
        })
        for (const execution of task.executions) {
          if (newest === undefined || execution.startedAt >= newest.startedAt) {
            newest = { startedAt: execution.startedAt, endedAt: execution.endedAt }
          }
        }
      }
      return {
        id: group.id,
        mode: group.mode,
        ...(group.maxParallel === undefined ? {} : { maxParallel: group.maxParallel }),
        ...(group.allowedHours === undefined ? {} : { allowedHours: group.allowedHours }),
        offPeakOnly: group.offPeakOnly,
        stopped: group.stopped === true,
        paused: group.paused === true,
        scheduleEnabled: group.schedule?.enabled === true,
        newestExecutionSettled: newest !== undefined && newest.endedAt !== undefined,
        ...(group.finalStepTaskId === undefined ? {} : { finalStepTaskId: group.finalStepTaskId }),
        finalStepReady: groupFinalStepReady(group, this.document.tasks),
        order: [...group.order],
        members,
      }
    })
  }

  /**
   * The shared session of a maintain-session group: the session of the group's
   * newest settled member execution. A sequential group runs one member at a
   * time, so when the next member launches, the previous member's execution is
   * the newest settled one and its session is the conversation to continue.
   * Absent when no member has settled yet (the first member then creates a
   * fresh session) or the only settled executions have no session (queued runs
   * that never launched).
   */
  groupSharedSession(groupId: string): { sessionId: string; taskId: string } | undefined {
    let newest: { sessionId: string; taskId: string; endedAt: number } | undefined
    for (const task of this.document.tasks) {
      if (task.groupId !== groupId) continue
      for (const execution of task.executions) {
        if (execution.endedAt === undefined || execution.sessionId === undefined) continue
        if (newest === undefined || execution.endedAt > newest.endedAt) {
          newest = { sessionId: execution.sessionId, taskId: task.id, endedAt: execution.endedAt }
        }
      }
    }
    return newest === undefined ? undefined : { sessionId: newest.sessionId, taskId: newest.taskId }
  }

  /**
   * Open a fresh execution on a task without any schedule bookkeeping (the
   * group sequence's auto-advance path). No-op when the task is running,
   * already has an open execution, is archived, or is unknown.
   */
  openExecution(taskId: string, now: number): OpenedRun | undefined {
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined || task.archivedAt !== undefined) return undefined
    if (task.status === 'running' || hasOpenExecution(task)) return undefined
    // An unapproved member can never be launched by the group sequence
    // (defensive; the advance pass already treats it as not runnable).
    if (task.approved === false) return undefined
    // A member pinned to a paused workspace is never launched (defensive; the
    // advance pass already treats it as not runnable).
    if (this.workspacePausedFor(task)) return undefined
    // A held member (deferAutoStart) is skipped by the group sequence until
    // an explicit start clears the hold (defensive; the advance pass already
    // excludes it from runnable).
    if (task.deferAutoStart === true) return undefined
    // The group's final step is gated: it never launches through the regular
    // chain until every other member has settled (defensive; the advance pass
    // launches it only through its own gate).
    if (task.groupId !== undefined) {
      const group = this.document.groups.find(candidate => candidate.id === task.groupId)
      if (group?.finalStepTaskId === taskId && !groupFinalStepReady(group, this.document.tasks)) return undefined
    }
    const opened = startExecution(task, now, crypto.randomUUID())
    this.document.tasks = this.document.tasks.map(item => item.id === taskId ? opened.task : item)
    this.commit()
    return opened
  }

  /** Return value-only references for group schedules due at the supplied Host time. */
  dueGroupSchedules(now: number): DueGroupScheduleReference[] {
    const due: DueGroupScheduleReference[] = []
    for (const group of this.document.groups) {
      const schedule = group.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      // A stopped or paused group's cron is held; the schedule resumes on
      // resume/continue.
      if (group.stopped === true || group.paused === true) continue
      due.push({ groupId: group.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  /** Roll a group's schedule rule forward (scheduler callback). */
  rollGroupSchedule(groupId: string, nextRunAt: number | undefined, lastTriggeredAt: number): void {
    this.document.groups = withGroupScheduleRoll(this.document.groups, groupId, nextRunAt, lastTriggeredAt, this.now())
    // A group-cron fire starts a fresh sequence cycle: every member's
    // auto-advance hold is cleared so the whole group participates.
    this.clearGroupAutoStartHolds(groupId)
    this.commit()
  }

  /**
   * Set or clear a task's auto-advance hold to match its group membership: a
   * member of a group whose sequence has started ({@link groupSequenceStarted})
   * is held so the chain never starts it automatically; an ungrouped task or
   * a member of a fresh, never-run group is not held. Called whenever a task's
   * membership changes (create into a group, group move, leave).
   */
  private syncGroupAutoStartHold(taskId: string, groupId: string | undefined): void {
    this.document.tasks = this.document.tasks.map(task => {
      if (task.id !== taskId) return task
      if (groupId === undefined) {
        const { deferAutoStart: _held, ...rest } = task
        return { ...rest, updatedAt: this.now() }
      }
      const group = this.document.groups.find(candidate => candidate.id === groupId)
      if (group === undefined) return task
      if (groupSequenceStarted(group, this.document.tasks)) {
        return task.deferAutoStart === true ? task : { ...task, deferAutoStart: true, updatedAt: this.now() }
      }
      const { deferAutoStart: _held, ...rest } = task
      return { ...rest, updatedAt: this.now() }
    })
  }

  /** Clear the auto-advance hold on every member of one group (a new sequence cycle). */
  private clearGroupAutoStartHolds(groupId: string): void {
    this.document.tasks = this.document.tasks.map(task =>
      task.groupId === groupId && task.deferAutoStart === true
        ? (() => {
          const { deferAutoStart: _held, ...rest } = task
          return { ...rest, updatedAt: this.now() }
        })()
        : task)
  }

  /** Record the endpoint a launched (or about-to-launch) run is routed through. */
  attachEndpoint(taskId: string, executionId: string, endpointId: string): void {
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: this.now(),
      executions: task.executions.map(entry => entry.id !== executionId ? entry : { ...entry, endpointId }),
    })
    this.commit()
  }

  /** Count armed, non-archived schedules (task and group) without cloning. */
  armedScheduleCount(): number {
    let count = 0
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) count += 1
    }
    for (const group of this.document.groups) {
      if (group.schedule?.enabled === true) count += 1
    }
    return count
  }

  /**
   * Return value-only references for task schedules due at the supplied Host
   * time. A task whose group has an enabled schedule is skipped: its own cron
   * is ignored while the group cron governs the sequence (members inherit it).
   * A task whose group is stopped or paused is skipped too: stopping/pausing
   * the group holds every member cron until the group resumes/continues.
   */
  dueSchedules(now: number): DueScheduleReference[] {
    const groupScheduled = new Set<string>()
    const heldGroups = new Set<string>()
    for (const group of this.document.groups) {
      if (group.schedule?.enabled === true) groupScheduled.add(group.id)
      if (group.stopped === true || group.paused === true) heldGroups.add(group.id)
    }
    const due: DueScheduleReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined) continue
      if (task.groupId !== undefined && (groupScheduled.has(task.groupId) || heldGroups.has(task.groupId))) continue
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      due.push({ taskId: task.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Subscribe to executions that actually settle (distinct from every mutation). */
  onSettled(listener: (event: SettlementEvent) => void): () => void {
    this.settledListeners.add(listener)
    return () => { this.settledListeners.delete(listener) }
  }

  private notifySettled(event: SettlementEvent): void {
    for (const listener of [...this.settledListeners]) listener(event)
  }

  dispose(): void {
    const fd = this.lockFd
    if (fd === undefined) return
    this.lockFd = undefined
    closeSync(fd)
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { token?: unknown }
      if (owner.token === this.lockToken) unlinkSync(this.lockFile)
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }

  applyRequest(requestId: string, action: AllTasksAction): LedgerApplyResult {
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.state() }
    }

    // Add the fingerprint before apply(): successful actions persist it in the
    // same atomic ledger write as their state transition.
    this.requestCache.set(requestId, { fingerprint })
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    this.syncRecentRequests()
    try {
      return this.apply(action)
    } catch (error) {
      this.requestCache.delete(requestId)
      this.syncRecentRequests()
      throw error
    }
  }

  openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined {
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined || task.archivedAt !== undefined) return undefined
    // A task whose group has an enabled schedule is governed by the group cron;
    // its own cron must never fire it (defensive; dueSchedules already skips).
    if (task.groupId !== undefined && this.document.groups.some(group => group.id === task.groupId && (group.schedule?.enabled === true || group.stopped === true || group.paused === true))) {
      return undefined
    }
    // An unapproved task's cron is held like a running task's: the occurrence
    // rolls forward without launching, so the schedule keeps its cadence and
    // resumes firing at the next occurrence once the task is approved. A task
    // pinned to a paused workspace is held the same way until the workspace
    // is continued.
    if (task.approved === false || task.status === 'running' || hasOpenExecution(task) || this.workspacePausedFor(task)) {
      this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, task.schedule?.lastTriggeredAt, triggeredAt)]
      this.commit()
      return undefined
    }
    const opened = startExecution(task, triggeredAt, crypto.randomUUID())
    this.document.tasks = this.document.tasks.map(item => item.id === taskId ? opened.task : item)
    this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, triggeredAt, triggeredAt)]
    this.commit()
    return opened
  }

  skipMissed(now: number): void {
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: nextRunAtMs(schedule.cron, now) }, updatedAt: now }
    })
    this.document.groups = this.document.groups.map(group => {
      const schedule = group.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) return group
      changed = true
      return { ...group, schedule: { ...schedule, nextRunAt: nextRunAtMs(schedule.cron, now) }, updatedAt: now }
    })
    if (changed) this.commit()
  }

  setScheduler(patch: Partial<AllTasksSchedulerSnapshot>): void {
    this.document.scheduler = { ...this.document.scheduler, ...patch }
    // The 30 s heartbeat only moves lastTickAt; rewriting the whole ledger
    // for it made idle idle cost O(ledger bytes) every tick. Persist it to a
    // tiny sidecar instead; any other patch still goes through the full
    // atomic commit.
    if (patch.lastTickAt !== undefined && Object.keys(patch).every(key => key === 'lastTickAt')) {
      this.writeSchedulerSidecar()
      return
    }
    this.commit(false)
  }

  attachSession(taskId: string, executionId: string, sessionId: string): void {
    const now = this.now()
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: now,
      executions: task.executions.map(entry => entry.id === executionId ? { ...entry, sessionId, launchedAt: now } : entry),
    })
    this.commit()
  }

  settle(taskId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string, summary?: string, usage?: ExecutionUsage): void {
    const open = this.document.tasks
      .find(task => task.id === taskId)
      ?.executions.find(execution => execution.id === executionId)
    const wasOpen = open !== undefined && open.endedAt === undefined
    this.document.tasks = this.document.tasks.map(task => task.id === taskId
      ? settleExecution(task, executionId, outcome, this.now(), error, summary, usage)
      : task)
    this.commit()
    if (wasOpen) {
      this.notifySettled({
        taskId,
        executionId,
        outcome,
        ...(error === undefined ? {} : { error }),
        ...(summary === undefined ? {} : { summary }),
        ...(usage === undefined ? {} : { usage }),
        ...(open?.sessionId === undefined ? {} : { sessionId: open.sessionId }),
      })
    }
  }

  private apply(action: AllTasksAction): LedgerApplyResult {
    const now = this.now()
    let run: OpenedRun | undefined
    let runs: OpenedRun[] | undefined
    const stopSessions: string[] = []
    const resumeRuns: ResumeRun[] = []
    let archiveSessions: string[] | undefined
    switch (action.kind) {
      case 'import': {
        const sources = new Set(this.document.scheduler.importedSources ?? [])
        if (sources.has(action.sourceId)) return { state: this.state() }
        const invalidScheduleIds = action.tasks
          .filter(task => task.schedule !== undefined && !isValidCron(task.schedule.cron))
          .map(task => task.id)
        const incoming = parseHostTasks(action.tasks)
        const merged = new Map(this.document.tasks.map(task => [task.id, task]))
        for (const task of incoming) merged.set(task.id, merged.has(task.id) ? mergeTask(merged.get(task.id)!, task) : task)
        this.document.tasks = [...merged.values()]
        // Groups are workspace-scoped: an imported task referencing a vanished
        // group or one of another workspace scope loses the reference (the
        // same healing the loader applies), so it never renders invisibly.
        this.document.tasks = this.document.tasks.map(task => {
          if (task.groupId === undefined) return task
          const group = this.document.groups.find(candidate => candidate.id === task.groupId)
          if (group !== undefined && taskMatchesGroupScope(task, group)) return task
          const { groupId: _dangling, ...rest } = task
          return rest
        })
        this.document.scheduler.importedSources = [...sources, action.sourceId]
        this.document.scheduler.error = invalidScheduleIds.length === 0
          ? undefined
          : `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}`
        this.repairSchedules(true, false)
        this.reconcileInterruptedStarts(false)
        break
      }
      case 'create': {
        if (this.document.tasks.some(task => task.id === action.id)) throw new Error('task id already exists')
        if (action.input.schedule?.enabled === true && (!isValidCron(action.input.schedule.cron) || nextRunAtMs(action.input.schedule.cron, now) === undefined)) {
          throw new Error('invalid schedule')
        }
        const result = applyCreateTask(this.document.tasks, action.input, now, action.id)
        if (result.task === undefined) throw new Error('invalid task')
        const created = result.task
        if (created.groupId !== undefined) {
          // A group is workspace-scoped: the task may join only when its own
          // workspace pin equals the group's scope (absent = unassigned).
          const group = this.document.groups.find(candidate => candidate.id === created.groupId)
          if (group === undefined) throw new Error('group not found')
          if (!taskMatchesGroupScope(created, group)) throw new Error('group does not belong to the task workspace')
        }
        this.document.tasks = [...result.tasks]
        if (created.groupId !== undefined) {
          this.document.groups = withGroupMembershipChange(this.document.groups, action.id, undefined, created.groupId, now)
          // A task created into a group whose sequence already started is
          // held from auto-advance (the chain must not start it on its own).
          this.syncGroupAutoStartHold(action.id, created.groupId)
        }
        break
      }
      case 'update': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // The task content (title/description/prompt) is the record of what
        // was planned; once an execution started it must not change under a
        // running session or an executed history. Execution targets stay
        // editable (they only affect future runs).
        if (hasContentPatch(action.patch) && !canEditTaskContent(task)) {
          throw new Error('task has already been executed')
        }
        if ('title' in action.patch && action.patch.title?.trim() === '') throw new Error('title is required')
        const previousGroupId = task.groupId
        // The workspace the task lands in after this patch (mirror of the
        // applyUpdateTask normalization: absent/blank = unassigned).
        const nextWorkspaceId = 'workspaceId' in action.patch
          ? (action.patch.workspaceId === undefined ? undefined : action.patch.workspaceId.trim() === '' ? undefined : action.patch.workspaceId.trim())
          : task.workspaceId
        // A patch that does not mention groupId leaves membership untouched;
        // only an explicit null (or a blank/unknown id) ungroups the task.
        // Treating an absent field as "ungroup" would drop a grouped task from
        // its group's member order on every content/target edit.
        const explicitGroupChange = 'groupId' in action.patch
        let nextGroupId = explicitGroupChange
          ? (action.patch.groupId === null || action.patch.groupId === undefined
            ? undefined
            : action.patch.groupId.trim() === '' ? undefined : action.patch.groupId.trim())
          : previousGroupId
        if (nextGroupId !== undefined) {
          const group = this.document.groups.find(candidate => candidate.id === nextGroupId)
          if (group === undefined) throw new Error('group not found')
          if (group.workspaceId !== nextWorkspaceId) {
            // An explicit mismatched join is a user error (fail closed); an
            // implicit keep-through (the patch only moved the workspace) means
            // the task left its old workspace's scope, so it leaves the group.
            if (explicitGroupChange) throw new Error('group does not belong to the task workspace')
            nextGroupId = undefined
          }
        }
        // A running member keeps its group's capacity slot until its execution
        // settles; moving it between groups (or out of the group) would leak
        // the slot and let the old group start a second member while the first
        // is still running. Mirrors the delete/move running-task refusals.
        if ((task.status === 'running' || hasOpenExecution(task)) && previousGroupId !== nextGroupId) {
          throw new Error('running task cannot be moved between groups')
        }
        const membershipChanged = previousGroupId !== nextGroupId
        // When the workspace move implicitly ungrouped the task, the task's
        // own groupId must clear too — not just the group's member order.
        const effectivePatch = membershipChanged && nextGroupId === undefined && previousGroupId !== undefined
          ? { ...action.patch, groupId: null }
          : action.patch
        this.document.tasks = [...applyUpdateTask(this.document.tasks, action.taskId, effectivePatch, now)]
        if (membershipChanged) {
          this.document.groups = withGroupMembershipChange(this.document.groups, action.taskId, previousGroupId, nextGroupId, now)
          // A membership change recomputes the auto-advance hold against the
          // destination group: joining a started group holds the member,
          // leaving a group (or joining a fresh one) clears it.
          this.syncGroupAutoStartHold(action.taskId, nextGroupId)
        }
        break
      }
      case 'delete':
        {
          const task = this.document.tasks.find(task => task.id === action.taskId)
          if (task === undefined) throw new Error('task not found')
          if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be deleted')
          if (task.groupId !== undefined) {
            this.document.groups = withGroupMembershipChange(this.document.groups, action.taskId, task.groupId, undefined, now)
          }
        }
        this.document.tasks = [...applyDeleteTask(this.document.tasks, undefined, action.taskId).tasks]
        break
      case 'move': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be moved')
        if (!canMoveManually(task.status, action.status)) throw new Error('invalid manual status')
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? withStatus(item, action.status, now) : item)
        break
      }
      case 'reorder': {
        // Reorder the ledger array (the ungrouped display order). The moved
        // task must exist and stay where it is when the target is itself;
        // `beforeTaskId: null` means the end of the array. Status and group
        // membership are untouched — a reorder is a pure position change.
        if (!this.document.tasks.some(task => task.id === action.taskId)) throw new Error('task not found')
        if (action.beforeTaskId !== null && !this.document.tasks.some(task => task.id === action.beforeTaskId)) {
          throw new Error('target task not found')
        }
        const reordered = moveTaskBefore(this.document.tasks, action.taskId, action.beforeTaskId ?? undefined)
        // A drop that lands back where the card came from changes nothing:
        // leave the array untouched so the commit rewrites an identical ledger.
        if (reordered !== this.document.tasks) {
          this.document.tasks = [...reordered]
        }
        break
      }
      case 'archive': {
        const result = applyArchiveTask(this.document.tasks, action.taskId, now)
        if (!result.archived) throw new Error('task cannot be archived')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'restore': {
        const result = applyRestoreTask(this.document.tasks, action.taskId, now)
        if (!result.archived) throw new Error('task is not archived')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'hide-tasks': {
        // The bulk hide of a Done/Failed column: archive every requested
        // settled task in one ledger revision. All-or-nothing — an unknown,
        // still-open, or already-archived id fails the whole action so a
        // column never half-disappears behind a stray stale id.
        const before = this.document.tasks
        const result = applyArchiveTasks(before, action.taskIds, now)
        if (!result.allArchived) throw new Error('task cannot be archived')
        this.document.tasks = [...result.tasks]
        // The session set is derived from the ledger executions of the tasks
        // being hidden, never accepted from the wire: the browser only says
        // whether it wants the sessions archived too.
        if (action.archiveSessions) {
          const sessions = collectExecutionSessionIds(before, action.taskIds)
          if (sessions.length > 0) archiveSessions = [...sessions]
        }
        break
      }
      case 'set-schedule': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        const result = applySetSchedule(this.document.tasks, action.taskId, action.patch, now)
        if (!result.applied) throw new Error('invalid schedule')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'rerun':
      case 'run': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task === undefined || task.status === 'running' || hasOpenExecution(task)) throw new Error('task is already running or missing')
        // An unapproved task can never be run by any means — manual runs and
        // reruns are refused here; crons and group auto-advance skip it too.
        if (task.approved === false) throw new Error('task is not approved')
        if (task.groupId !== undefined) {
          const group = this.document.groups.find(candidate => candidate.id === task.groupId)
          if (group?.stopped === true) throw new Error('group is stopped')
          if (group?.paused === true) throw new Error('group is paused')
          // The group's final step is gated: it cannot be started by hand
          // while any other member is still unfinished.
          if (group?.finalStepTaskId === task.id && groupFinalStepBlocked(group, this.document.tasks)) {
            throw new Error('final step waits for all group members to settle')
          }
        }
        // A task pinned to a paused workspace never launches by any means until
        // the workspace is continued.
        if (this.workspacePausedFor(task)) throw new Error('workspace is paused')
        const base = action.kind === 'rerun' ? withStatus(task, 'todo', now) : task
        const opened = startExecution(base, now, crypto.randomUUID())
        // A manual run is an explicit start: it clears the member's
        // auto-advance hold (the user asked for it directly).
        const { deferAutoStart: _held, ...unheld } = opened.task
        run = { task: unheld, execution: opened.execution }
        this.document.tasks = this.document.tasks.map(item => item.id === task.id ? run!.task : item)
        break
      }
      case 'stop': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        const execution = task.executions.find(entry => entry.endedAt === undefined)
        if (execution === undefined) throw new Error('task is not running')
        if (execution.sessionId !== undefined) stopSessions.push(execution.sessionId)
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId
          ? settleExecution(item, execution.id, 'cancelled', now, 'stopped by user')
          : item)
        break
      }
      case 'stop-group': {
        if (!this.document.groups.some(group => group.id === action.groupId)) throw new Error('group not found')
        this.document.tasks = this.document.tasks.map(task => {
          if (task.groupId !== action.groupId) return task
          const execution = task.executions.find(entry => entry.endedAt === undefined)
          if (execution === undefined) return task
          if (execution.sessionId !== undefined) stopSessions.push(execution.sessionId)
          return settleExecution(task, execution.id, 'cancelled', now, 'group stopped by user')
        })
        this.document.groups = this.document.groups.map(group => {
          if (group.id !== action.groupId) return group
          // A stop settles every open member (paused or not) as cancelled, so a
          // stale paused flag is cleared with the stop flag.
          const { paused: _paused, ...rest } = group
          return { ...rest, stopped: true, updatedAt: now }
        })
        break
      }
      case 'pause': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        const execution = task.executions.find(entry => entry.endedAt === undefined)
        if (execution === undefined) throw new Error('task is not running')
        if (execution.pausedAt !== undefined) throw new Error('task is already paused')
        if (execution.sessionId !== undefined) stopSessions.push(execution.sessionId)
        const paused = pauseExecution(task, execution.id, now)
        if (paused === undefined) throw new Error('task is not running')
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? paused : item)
        break
      }
      case 'continue': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        const execution = task.executions.find(entry => entry.endedAt === undefined)
        if (execution === undefined || execution.pausedAt === undefined) throw new Error('task is not paused')
        const continued = continueExecution(task, execution.id, now)
        if (continued === undefined) throw new Error('task is not paused')
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? continued : item)
        if (execution.sessionId !== undefined) resumeRuns.push({ sessionId: execution.sessionId, task: continued })
        break
      }
      case 'pause-group': {
        const group = this.document.groups.find(candidate => candidate.id === action.groupId)
        if (group === undefined) throw new Error('group not found')
        if (group.stopped === true) throw new Error('group is stopped')
        if (group.paused === true) throw new Error('group is already paused')
        this.document.tasks = this.document.tasks.map(task => {
          if (task.groupId !== action.groupId) return task
          const execution = task.executions.find(entry => entry.endedAt === undefined)
          if (execution === undefined || execution.pausedAt !== undefined) return task
          if (execution.sessionId !== undefined) stopSessions.push(execution.sessionId)
          return pauseExecution(task, execution.id, now) ?? task
        })
        this.document.groups = this.document.groups.map(candidate => candidate.id === action.groupId
          ? { ...candidate, paused: true, updatedAt: now }
          : candidate)
        break
      }
      case 'continue-group': {
        const group = this.document.groups.find(candidate => candidate.id === action.groupId)
        if (group === undefined) throw new Error('group not found')
        if (group.paused !== true) throw new Error('group is not paused')
        this.document.tasks = this.document.tasks.map(task => {
          if (task.groupId !== action.groupId) return task
          const execution = task.executions.find(entry => entry.endedAt === undefined && entry.pausedAt !== undefined)
          if (execution === undefined) return task
          const continued = continueExecution(task, execution.id, now)
          if (continued === undefined) return task
          if (execution.sessionId !== undefined) resumeRuns.push({ sessionId: execution.sessionId, task: continued })
          return continued
        })
        this.document.groups = this.document.groups.map(candidate => {
          if (candidate.id !== action.groupId) return candidate
          const { paused: _paused, ...rest } = candidate
          return { ...rest, updatedAt: now }
        })
        break
      }
      case 'pause-workspace': {
        const workspaceId = action.workspaceId
        this.document.workspacePaused = { ...this.document.workspacePaused, [workspaceId]: now }
        this.document.tasks = this.document.tasks.map(task => {
          if (workspaceId !== '' && task.workspaceId !== workspaceId) return task
          const execution = task.executions.find(entry => entry.endedAt === undefined)
          if (execution === undefined || execution.pausedAt !== undefined) return task
          if (execution.sessionId !== undefined) stopSessions.push(execution.sessionId)
          return pauseExecution(task, execution.id, now) ?? task
        })
        break
      }
      case 'continue-workspace': {
        const workspaceId = action.workspaceId
        if (this.document.workspacePaused[workspaceId] === undefined) throw new Error('workspace is not paused')
        delete this.document.workspacePaused[workspaceId]
        this.document.workspacePaused = { ...this.document.workspacePaused }
        this.document.tasks = this.document.tasks.map(task => {
          if (workspaceId !== '' && task.workspaceId !== workspaceId) return task
          const execution = task.executions.find(entry => entry.endedAt === undefined && entry.pausedAt !== undefined)
          if (execution === undefined) return task
          const continued = continueExecution(task, execution.id, now)
          if (continued === undefined) return task
          if (execution.sessionId !== undefined) resumeRuns.push({ sessionId: execution.sessionId, task: continued })
          return continued
        })
        break
      }
      case 'set-approved': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // Approving clears the explicit flag (approved is the default);
        // unapproving persists the explicit `false` gate. The task stays
        // fully manageable (moves, edits, groups) either way.
        const approved = action.approved === true
        this.document.tasks = this.document.tasks.map(item => {
          if (item.id !== action.taskId) return item
          const { approved: _current, ...rest } = item
          return approved ? { ...rest, updatedAt: now } : { ...rest, approved: false, updatedAt: now }
        })
        break
      }
      case 'set-workspace-defaults': {
        // The protocol already normalized the patch; apply it onto the current
        // record (null clears a field) and drop the entry when nothing remains.
        const next = applyWorkspaceDefaultsPatch(this.document.workspaceDefaults[action.workspaceId], action.patch)
        if (next === undefined) {
          if (this.document.workspaceDefaults[action.workspaceId] !== undefined) {
            const { [action.workspaceId]: _removed, ...rest } = this.document.workspaceDefaults
            this.document.workspaceDefaults = rest
          }
          break
        }
        this.document.workspaceDefaults = { ...this.document.workspaceDefaults, [action.workspaceId]: next }
        break
      }
      case 'run-group': {
        const group = this.document.groups.find(candidate => candidate.id === action.groupId)
        if (group === undefined) throw new Error('group not found')
        if (group.stopped === true) throw new Error('group is stopped')
        if (group.paused === true) throw new Error('group is paused')
        // Manual group start is an explicit new sequence cycle: it clears
        // every member's auto-advance hold so the whole group participates.
        this.clearGroupAutoStartHolds(action.groupId)
        // Manual group start: open an execution for runnable members in group
        // order (on-board, approved, backlog/todo, no open run), up to the
        // group's launch capacity — sequential opens one member, parallel opens
        // up to maxParallel (absent = unlimited). The router launches or queues
        // each opened run (window/endpoint/capacity), and the group
        // auto-advance chain starts the members beyond capacity as launched
        // members settle, exactly as after a group cron.
        const runnable = group.order
          .map(id => this.document.tasks.find(task => task.id === id))
          .filter((task): task is TaskRecord => task !== undefined
            && task.archivedAt === undefined
            && task.approved !== false
            && (task.status === 'backlog' || task.status === 'todo')
            && !this.workspacePausedFor(task)
            && !hasOpenExecution(task))
        // The group's final step never joins the parallel burst: it opens only
        // once every other member has settled (its own gate below).
        const burst = runnable.filter(task => task.id !== group.finalStepTaskId)
        if (burst.length === 0 && !groupFinalStepReady(group, this.document.tasks)) {
          throw new Error('no runnable members')
        }
        const capacity = group.mode === 'sequential' ? 1 : group.maxParallel ?? Number.POSITIVE_INFINITY
        const openedRuns = burst.slice(0, capacity).map(task => startExecution(task, now, crypto.randomUUID()))
        // A final step whose gate already passes opens as its own run — the
        // "every member settled, merge still pending" start.
        if (group.finalStepTaskId !== undefined && groupFinalStepReady(group, this.document.tasks)) {
          const finalStepTask = this.document.tasks.find(task => task.id === group.finalStepTaskId)
          if (finalStepTask !== undefined) {
            openedRuns.push(startExecution(finalStepTask, now, crypto.randomUUID()))
          }
        }
        runs = openedRuns
        this.document.tasks = this.document.tasks.map(task => {
          const opened = runs!.find(candidate => candidate.task.id === task.id)
          return opened === undefined ? task : opened.task
        })
        break
      }
      case 'move-group': {
        const group = this.document.groups.find(candidate => candidate.id === action.groupId)
        if (group === undefined) throw new Error('group not found')
        if (!MANUAL_STATUSES.includes(action.status)) throw new Error('invalid manual status')
        // Moving a group moves every on-board member; running or queued
        // members cannot be moved (same rule as individual moves).
        const members = this.document.tasks.filter(task => task.groupId === action.groupId && task.archivedAt === undefined)
        if (members.some(member => member.status === 'running' || hasOpenExecution(member))) {
          throw new Error('group has running tasks')
        }
        // Dropping the group back onto its own column changes nothing: skip
        // the status rewrite so no member's updatedAt (its "edited" stamp)
        // gets bumped for a no-op move.
        if (members.length > 0 && members.every(member => member.status === action.status)) break
        this.document.tasks = this.document.tasks.map(task =>
          task.groupId === action.groupId && task.archivedAt === undefined
            ? withStatus(task, action.status, now)
            : task)
        break
      }
      case 'create-group': {
        if (this.document.groups.some(group => group.id === action.id)) throw new Error('group id already exists')
        const result = applyCreateGroup(this.document.groups, action.input, now, action.id)
        if (result.group === undefined) throw new Error('invalid group')
        this.document.groups = [...result.groups]
        break
      }
      case 'update-group': {
        const result = applyUpdateGroup(this.document.groups, action.groupId, action.patch as GroupUpdatePatch, now)
        if (!result.applied) throw new Error('group not found or invalid patch')
        this.document.groups = [...result.groups]
        break
      }
      case 'delete-group': {
        if (!this.document.groups.some(group => group.id === action.groupId)) throw new Error('group not found')
        // Ungrouping a member mid-run would change its routing gating under a
        // live execution; refuse while any member has an open run.
        if (this.document.tasks.some(task => task.groupId === action.groupId && hasOpenExecution(task))) {
          throw new Error('group has running tasks')
        }
        const ungroupedIds = new Set(this.document.tasks
          .filter(task => task.groupId === action.groupId)
          .map(task => task.id))
        const result = applyDeleteGroup(this.document.tasks, this.document.groups, action.groupId, now)
        if (!result.applied) throw new Error('group not found')
        this.document.tasks = [...result.tasks]
        this.document.groups = [...result.groups]
        // Ungrouped members have no auto-advance chain; clear any lingering hold.
        this.document.tasks = this.document.tasks.map(task =>
          ungroupedIds.has(task.id) && task.deferAutoStart === true
            ? (() => {
              const { deferAutoStart: _held, ...rest } = task
              return { ...rest, updatedAt: this.now() }
            })()
            : task)
        break
      }
      case 'set-group-order': {
        const group = this.document.groups.find(candidate => candidate.id === action.groupId)
        if (group === undefined) throw new Error('group not found')
        // The order is a preference prefix: every listed id must be a member
        // and appear once; members not listed keep their current relative
        // position (appended by the normalize step). Archived members cannot
        // be ungrouped through update-task, so the UI never sends them.
        const memberIds = this.document.tasks
          .filter(task => task.groupId === action.groupId)
          .map(task => task.id)
        const memberSet = new Set(memberIds)
        const orderSet = new Set(action.order)
        if (orderSet.size !== action.order.length || !action.order.every(id => memberSet.has(id))) {
          throw new Error('order does not match group members')
        }
        this.document.groups = withGroupOrder(this.document.groups, action.groupId, action.order, memberIds, now)
        break
      }
    }
    // Invariant: a group's order always covers exactly its current members.
    // Member additions append, removals drop the id; the defensive pass below
    // heals any stale/partial order left by an edit so a member can never
    // silently drift to the end of its group's section on the board.
    this.normalizeGroupOrders(now)
    this.commit()
    return {
      state: this.state(),
      ...(run === undefined ? {} : { run }),
      ...(runs === undefined || runs.length === 0 ? {} : { runs }),
      ...(stopSessions.length > 0 ? { stopSessions } : {}),
      ...(resumeRuns.length > 0 ? { resumeRuns } : {}),
      ...(archiveSessions === undefined || archiveSessions.length === 0 ? {} : { archiveSessions }),
    }
  }

  /**
   * Re-derive every group's member order against its current member tasks:
   * listed ids keep their order, members missing from the list are appended
   * (in ledger order), and dangling ids are dropped. A group whose order is
   * already exact is left untouched, so this is a pure invariant pass.
   */
  private normalizeGroupOrders(now: number): void {
    // Members are workspace-scoped: a task whose workspace pin does not match
    // the group's scope never counts toward its order (defensive — every
    // membership transition and the loader already enforce this).
    const scopes = new Map(this.document.groups.map(group => [group.id, group.workspaceId]))
    const membersByGroup = new Map<string, string[]>()
    for (const task of this.document.tasks) {
      if (task.groupId === undefined) continue
      if (!scopes.has(task.groupId) || task.workspaceId !== scopes.get(task.groupId)) continue
      const list = membersByGroup.get(task.groupId) ?? []
      list.push(task.id)
      membersByGroup.set(task.groupId, list)
    }
    this.document.groups = this.document.groups.map(group => {
      const order = normalizeGroupOrder(group.order, membersByGroup.get(group.id) ?? [])
      // The final-step designation cannot dangle: a reference to a member that
      // vanished (deleted, moved away, or out of scope) is cleared alongside
      // the order repair.
      const memberSet = new Set(order)
      const finalStepTaskId = group.finalStepTaskId !== undefined && memberSet.has(group.finalStepTaskId)
        ? group.finalStepTaskId
        : undefined
      const orderUnchanged = order.length === group.order.length && order.every((id, index) => id === group.order[index])
      if (orderUnchanged && finalStepTaskId === group.finalStepTaskId) return group
      const next: TaskGroupRecord = { ...group, order }
      if (finalStepTaskId === undefined) delete next.finalStepTaskId
      return { ...next, updatedAt: now }
    })
  }

  private repairSchedules(skipPast: boolean, persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled) return task
      if (!skipPast && schedule.nextRunAt !== undefined) return task
      const next = nextRunAtMs(schedule.cron, now)
      if (next === undefined) {
        changed = true
        this.document.scheduler.error = `invalid cron disabled for task: ${task.id}`
        return { ...task, schedule: { ...schedule, enabled: false, nextRunAt: undefined }, updatedAt: now }
      }
      if (schedule.nextRunAt === next) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: next }, updatedAt: now }
    })
    this.document.groups = this.document.groups.map(group => {
      const schedule = group.schedule
      if (schedule === undefined || !schedule.enabled) return group
      if (!skipPast && schedule.nextRunAt !== undefined) return group
      const next = nextRunAtMs(schedule.cron, now)
      if (next === undefined) {
        changed = true
        this.document.scheduler.error = `invalid cron disabled for group: ${group.id}`
        return { ...group, schedule: { ...schedule, enabled: false, nextRunAt: undefined }, updatedAt: now }
      }
      if (schedule.nextRunAt === next) return group
      changed = true
      return { ...group, schedule: { ...schedule, nextRunAt: next }, updatedAt: now }
    })
    if (changed && persist) this.commit()
  }

  private reconcileInterruptedStarts(persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      if (task.status !== 'running') return task
      const execution = task.executions.at(-1)
      if (execution === undefined || execution.endedAt !== undefined || execution.sessionId !== undefined) return task
      // A queued run (waiting for an eligible endpoint) has no session yet by
      // design; it survives the restart and the router resumes it.
      if (execution.queuedAt !== undefined) return task
      changed = true
      return settleExecution(task, execution.id, 'cancelled', now, 'host restarted before the execution session was recorded')
    })
    if (changed && persist) this.commit()
  }

  private load(dir: string): LedgerDocument {
    const existed = existsSync(this.file)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerDocument>
      if (parsed.schemaVersion !== ALL_TASKS_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) throw new Error('unsupported ledger schema')
      // Groups are workspace-scoped: normalize against the parsed tasks so a
      // legacy group without an explicit scope adopts its members' workspace
      // (the one-time migration), then drop any membership whose task
      // workspace does not match the group's scope — a task pointing at a
      // vanished group loses the dangling reference the same way — before the
      // group order is re-derived.
      const tasksPre = parseHostTasks(parsed.tasks)
      const groupsProto = normalizeGroupRows(parsed.groups, tasksPre)
      const groupScopes = new Map(groupsProto.map(group => [group.id, group.workspaceId]))
      const tasks = tasksPre.map(task => {
        const normalized = { ...task, executions: retainRecentExecutions(task.executions) }
        if (normalized.groupId === undefined) return normalized
        if (groupScopes.has(normalized.groupId) && normalized.workspaceId === groupScopes.get(normalized.groupId)) return normalized
        const { groupId: _dangling, ...rest } = normalized
        return rest
      })
      const groups = normalizeGroupRows(parsed.groups, tasks)
      const invalidScheduleIds = (parsed.tasks as unknown[]).flatMap(value => {
        if (typeof value !== 'object' || value === null) return []
        const row = value as { id?: unknown; schedule?: unknown }
        if (typeof row.schedule !== 'object' || row.schedule === null) return []
        const cron = (row.schedule as { cron?: unknown }).cron
        return typeof cron !== 'string' || !isValidCron(cron)
          ? [typeof row.id === 'string' ? row.id : 'unknown']
          : []
      })
      const documentLastTickAt = typeof parsed.scheduler?.lastTickAt === 'number' ? parsed.scheduler.lastTickAt : undefined
      const sidecarLastTickAt = this.readSchedulerSidecar()
      // A sidecar write can be newer than the last full commit (crash between
      // the two); lastTickAt only ever moves forward, so take the greater.
      const lastTickAt = sidecarLastTickAt === undefined || (documentLastTickAt !== undefined && documentLastTickAt >= sidecarLastTickAt)
        ? documentLastTickAt
        : sidecarLastTickAt
      return {
        schemaVersion: ALL_TASKS_SCHEMA_VERSION,
        revision: Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0 ? parsed.revision as number : 0,
        tasks,
        groups,
        workspaceDefaults: normalizeWorkspaceDefaultsMap(parsed.workspaceDefaults),
        workspacePaused: normalizeWorkspacePaused(parsed.workspacePaused),
        scheduler: {
          timeZone: timeZone(),
          ledgerId: typeof parsed.scheduler?.ledgerId === 'string' && parsed.scheduler.ledgerId !== '' ? parsed.scheduler.ledgerId : crypto.randomUUID(),
          ...(lastTickAt === undefined ? {} : { lastTickAt }),
          ...(typeof parsed.scheduler?.error === 'string' ? { error: parsed.scheduler.error } : {}),
          ...(invalidScheduleIds.length > 0 ? { error: `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}` } : {}),
          ...(Array.isArray(parsed.scheduler?.importedSources) ? { importedSources: parsed.scheduler.importedSources.filter(x => typeof x === 'string') } : {}),
        },
        recentRequests: Array.isArray(parsed.recentRequests)
          ? parsed.recentRequests.flatMap((entry) => {
              if (typeof entry !== 'object' || entry === null) return []
              const request = entry as { requestId?: unknown; fingerprint?: unknown }
              return typeof request.requestId === 'string' && request.requestId !== '' && typeof request.fingerprint === 'string'
                ? [{ requestId: request.requestId, fingerprint: request.fingerprint }]
                : []
            }).slice(-MAX_REQUEST_CACHE)
          : [],
      }
    } catch (error) {
      if (existed) renameSync(this.file, `${this.file}.corrupt-${this.now()}-${process.pid}-${crypto.randomUUID()}`)
      mkdirSync(dir, { recursive: true })
      return {
        schemaVersion: ALL_TASKS_SCHEMA_VERSION,
        revision: 0,
        tasks: [],
        groups: [],
        workspaceDefaults: {},
        workspacePaused: {},
        scheduler: { timeZone: timeZone(), ledgerId: crypto.randomUUID(), ...(existed ? { error: `corrupt ledger was quarantined: ${error instanceof Error ? error.message : String(error)}` } : {}) },
        recentRequests: [],
      }
    }
  }

  private syncRecentRequests(): void {
    this.document.recentRequests = [...this.requestCache].map(([requestId, request]) => ({
      requestId,
      fingerprint: request.fingerprint,
    }))
  }

  private readSchedulerSidecar(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.schedulerFile, 'utf8')) as { lastTickAt?: unknown }
      return typeof parsed.lastTickAt === 'number' && Number.isFinite(parsed.lastTickAt) ? parsed.lastTickAt : undefined
    } catch {
      return undefined
    }
  }

  /** Atomic write of the scheduler heartbeat sidecar (0600, tmp + rename + fsync). */
  private writeSchedulerSidecar(): void {
    const payload = JSON.stringify({ lastTickAt: this.document.scheduler.lastTickAt })
    mkdirSync(dirname(this.schedulerFile), { recursive: true })
    const tmp = `${this.schedulerFile}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, payload, { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.schedulerFile)
      try {
        const dirFd = openSync(dirname(this.schedulerFile), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private commit(bumpRevision = true): void {
    if (bumpRevision) this.document.revision += 1
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(this.document, null, 2), { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.file)
      try {
        const dirFd = openSync(dirname(this.file), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        const startedAt = ownProcessStartTimeMs()
        // Linux /proc and Windows PowerShell probes are ms-precise; locks they
        // write are compared strictly. Other POSIX probes (ps) stay
        // second-granularity, so their records are compared with the bounded
        // legacy tolerance.
        const probe = process.platform === 'linux' || process.platform === 'win32' ? 'exact' : 'legacy'
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt, probe }), { encoding: 'utf8' })
        fsyncSync(fd)
        try { chmodSync(this.lockFile, 0o600) } catch { /* Windows ACLs own access */ }
        return fd
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        let pid: number | undefined
        let ownerStartedAt: number | undefined
        let ownerExact = false
        try {
          const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: unknown; startedAt?: unknown; probe?: unknown }
          if (typeof owner.pid === 'number') pid = owner.pid
          if (typeof owner.startedAt === 'number') ownerStartedAt = owner.startedAt
          ownerExact = owner.probe === 'exact'
        } catch {
          // A power-loss mid-write can leave a truncated lock; the same event
          // killed the writer, so fail closed but explain the recovery.
          throw new Error(`all-tasks ledger lock is unreadable: ${this.lockFile}; if this is a leftover from an unclean shutdown and no other DSH host is running, remove it manually and retry`)
        }
        if (pid !== undefined && processIsAlive(pid)) {
          const actualStartedAt = pid === process.pid ? ownProcessStartTimeMs() : processStartTimeMs(pid)
          // A reused PID is exposed when the live process identity no longer
          // matches the recorded one: either the recorded start time differs
          // beyond the probe's resolution (strict for ms-precise 'exact'
          // records, a bounded legacy tolerance for old second-granularity
          // records written by ps), or (legacy locks without a start time)
          // the lock file predates the live process and therefore cannot
          // have been written by it. Takeover is safe in both cases — the
          // original owner is gone.
          const staleReuse = actualStartedAt !== undefined && (
            ownerStartedAt !== undefined
              ? startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
              : (() => {
                try { return statSync(this.lockFile).mtimeMs < actualStartedAt } catch { return true }
              })()
          )
          if (!staleReuse) {
            const confirmedOwner = ownerStartedAt !== undefined && actualStartedAt !== undefined && !startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
            const hint = confirmedOwner
              ? ''
              : `; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockFile} manually and retry`
            throw new Error(`all-tasks ledger is already owned by process ${pid}${hint}`)
          }
        }
        try { unlinkSync(this.lockFile) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw new Error(`all-tasks ledger lock could not be acquired: ${this.lockFile}`)
  }
}
