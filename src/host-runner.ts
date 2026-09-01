import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { extractSummary } from './core/result-summary.ts'
import type { TaskRecord } from './core/tasks.ts'

function request<T>(payload: T) {
  return { rpcId: `task-board-${crypto.randomUUID()}` as RpcId, payload }
}

/**
 * Bound on the `/compact` command dispatched on a maintain-session group's
 * shared session before the next member's prompt. Compaction summarizes the
 * accumulated conversation through the LLM, which can take a while on a long
 * context; the bound is deliberately generous but still finite.
 */
const COMPACT_TIMEOUT_MS = 600_000

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

/** One session-list row, extracted from the sessions.list RPC result. */
export type SessionSummary = Extract<
  Awaited<ReturnType<ApiProxy['sessions']['list']>>['result'],
  { ok: true }
>['value']['items'][number]

type ExecutionSessionId = Extract<
  Awaited<ReturnType<ApiProxy['sessions']['create']>>['result'],
  { ok: true }
>['value']['sessionId']

export interface SessionCommandDispatcher {
  execute(
    sessionId: ExecutionSessionId,
    line: string,
    signal: AbortSignal,
  ): Promise<CommandResult | undefined>
}

export type ExecutionInspection =
  | { outcome: 'pending' }
  | { outcome: 'succeeded'; summary?: string }
  | { outcome: 'failed'; error: string; summary?: string }
  | { outcome: 'cancelled'; error: string }

/** A post-create launch failure that still identifies the session to the ledger. */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`execution session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'SessionLaunchError'
  }
}

/**
 * Classify one turn/end reason into the run outcome: an `error` reason is a
 * failure; an `aborted` reason (the user stopped the turn — the board's stop
 * buttons and DSH's own cancel both produce it) is a cancellation, never a
 * success; anything else (completed, blocked, max-tokens, interrupted) is a
 * success. Returns undefined when the payload carries no readable reason.
 */
function turnEndOutcome(data: unknown): 'succeeded' | 'failed' | 'cancelled' | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (kind === 'error') return 'failed'
  if (kind === 'aborted') return 'cancelled'
  return 'succeeded'
}

export class HostExecutionRunner {
  /**
   * Newest scanned event seq per session whose complete backward scan found
   * no matching turn/end. While a session's newest seq is unchanged a
   * re-scan cannot change the outcome, so only a one-message probe runs per
   * poll tick instead of up to 100 history pages.
   */
  private readonly scanMemos = new Map<string, number>()

  constructor(
    private readonly api: ApiProxy,
    private readonly commands?: SessionCommandDispatcher,
  ) {}

  /**
   * Launch one execution.
   * @param task - the task being run.
   * @param route - the endpoint router's resolved model selection (provider +
   *   model + optional effort). Present when the task was routed through an
   *   endpoint; absent means the task's own model pin applies (the direct
   *   behavior when no endpoints are configured).
   */
  async launch(task: TaskRecord, route?: { provider: string; model: string; reasoningEffort?: string }): Promise<string> {
    if (task.workspaceId !== undefined) {
      const workspaces = await this.api.workspace.list(request({}))
      if (!workspaces.result.ok) throw failure(workspaces.result.error)
      if (!workspaces.result.value.items.some(item => item.workspaceId === task.workspaceId)) {
        throw new Error(`workspace not found: ${task.workspaceId}`)
      }
    }
    if (task.mode !== undefined) {
      const presets = await this.api.agentPresets.list(request({}))
      if (!presets.result.ok) throw failure(presets.result.error)
      const preset = presets.result.value.presets.find(item => item.id === task.mode)
      if (preset === undefined) throw new Error(`agent preset not found: ${task.mode}`)
      if (preset.broken !== undefined) throw new Error(`agent preset is unavailable: ${preset.broken}`)
    }
    const created = await this.api.sessions.create(request({
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId as never }),
      ...(task.mode === undefined ? {} : { agentPreset: task.mode }),
    }))
    if (!created.result.ok) throw failure(created.result.error)
    const sessionId = created.result.value.sessionId
    try {
      // A pinned model selection is applied to the fresh session before the
      // prompt; a rejected selection fails closed (the session is recorded
      // but never queued), mirroring the workspace/preset/permission pins.
      // The router's resolved selection (when routed) takes precedence over
      // the task's own model pin.
      const selection = route ?? task.model
      if (selection !== undefined) {
        const selected = await this.api.sessions.selectModel(request({
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }))
        if (!selected.result.ok) throw failure(selected.result.error)
      }
      const renamed = await this.api.sessions.rename(request({ sessionId, title: task.title }))
      if (!renamed.result.ok) throw failure(renamed.result.error)
      if (task.permission !== undefined) {
        if (this.commands === undefined) throw new Error('permission command dispatcher is unavailable')
        const command = await this.commands.execute(sessionId, `/permission ${task.permission}`, AbortSignal.timeout(30_000))
        if (command === undefined) throw new Error('permission command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'permission command failed')
      }
      const prompt = await this.api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: task.prompt !== '' ? task.prompt : task.title }],
      }))
      if (!prompt.result.ok) throw failure(prompt.result.error)
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  async listRunning(): Promise<{ known: true; count: number; items: SessionSummary[] } | { known: false }> {
    try {
      const response = await this.api.sessions.list(request({}))
      return response.result.ok
        ? { known: true, count: response.result.value.items.filter(item => item.running).length, items: response.result.value.items }
        : { known: false }
    } catch {
      return { known: false }
    }
  }

  /** Whether a session still exists (the shared session of a maintain-session group). */
  async sessionExists(sessionId: string): Promise<boolean> {
    const response = await this.api.sessions.list(request({}))
    return response.result.ok && response.result.value.items.some(item => item.sessionId === sessionId)
  }

  /**
   * Launch one execution into an existing session (a maintain-session group's
   * shared conversation). The session's workspace/preset were composed when
   * the first member created it and cannot change; the member's own model and
   * permission pins are still applied per run, and `/compact` is dispatched
   * before the prompt when the group compacts between members — so a long
   * sequence stays within the context window while the earlier conversation
   * remains available as a summary.
   * @param task - the task being run.
   * @param route - the endpoint router's resolved model selection (provider +
   *   model + optional effort); absent means the task's own model pin applies.
   * @param sessionId - the shared session to continue.
   * @param compact - run `/compact` on the shared session before the prompt.
   */
  async launchShared(
    task: TaskRecord,
    route: { provider: string; model: string; reasoningEffort?: string } | undefined,
    sessionId: string,
    compact: boolean,
  ): Promise<string> {
    const executionSessionId = sessionId as ExecutionSessionId
    try {
      if (compact) {
        if (this.commands === undefined) throw new Error('compact command dispatcher is unavailable')
        const command = await this.commands.execute(executionSessionId, '/compact', AbortSignal.timeout(COMPACT_TIMEOUT_MS))
        if (command === undefined) throw new Error('compact command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'compact command failed')
      }
      const selection = route ?? task.model
      if (selection !== undefined) {
        const selected = await this.api.sessions.selectModel(request({
          sessionId: executionSessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }))
        if (!selected.result.ok) throw failure(selected.result.error)
      }
      if (task.permission !== undefined) {
        if (this.commands === undefined) throw new Error('permission command dispatcher is unavailable')
        const command = await this.commands.execute(executionSessionId, `/permission ${task.permission}`, AbortSignal.timeout(30_000))
        if (command === undefined) throw new Error('permission command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'permission command failed')
      }
      const prompt = await this.api.sessions.prompt(request({
        sessionId: executionSessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: task.prompt !== '' ? task.prompt : task.title }],
      }))
      if (!prompt.result.ok) throw failure(prompt.result.error)
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /**
   * Stop one execution's session: cancel the active turn (the board's stop
   * action settles the ledger first, then fires this so the agent actually
   * halts). Best-effort — a session that is already gone is not an error.
   */
  async cancel(sessionId: string): Promise<void> {
    const response = await this.api.sessions.cancel(request({ sessionId: sessionId as ExecutionSessionId }))
    if (!response.result.ok) throw failure(response.result.error)
  }

  /**
   * Resolve one execution's outcome. The caller may pass the session list it
   * already fetched this poll tick; otherwise inspect lists sessions itself.
   * Sharing the list keeps a poll with E open executions at one list RPC
   * instead of 1 + E.
   * @param launchedAt - when the execution's session was actually attached; the
   *   scan floor is `max(startedAt, launchedAt)`. A queued run has a stale
   *   `startedAt`, and a shared (maintain-session) session holds the previous
   *   member's turn — both must not settle this execution, so the launch
   *   instant is the authoritative boundary.
   */
  async inspect(sessionId: string, startedAt = 0, sessions?: readonly SessionSummary[], launchedAt?: number): Promise<ExecutionInspection> {
    const since = Math.max(startedAt, launchedAt ?? 0)
    let items: readonly SessionSummary[]
    if (sessions !== undefined) {
      items = sessions
    } else {
      const response = await this.api.sessions.list(request({}))
      if (!response.result.ok) return { outcome: 'pending' }
      items = response.result.value.items
    }
    const summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined) {
      this.scanMemos.delete(sessionId)
      return { outcome: 'cancelled', error: 'execution session no longer exists' }
    }
    if (summary.running) return { outcome: 'pending' }
    // Probe the newest event before paging: SessionSummary.updatedAt tracks
    // human prompts, not event appends, so only the history head proves
    // whether a re-scan could find anything new.
    const probe = await this.api.sessions.history(request({ sessionId: summary.sessionId, maxMessages: 1 }))
    if (!probe.result.ok) return { outcome: 'pending' }
    const newestSeq = probe.result.value.events.reduce<number | undefined>((newest, entry) => {
      const seq = entry.event.seq
      return typeof seq !== 'number' ? newest : newest === undefined ? seq : Math.max(newest, seq)
    }, undefined)
    if (newestSeq !== undefined && this.scanMemos.get(sessionId) === newestSeq) return { outcome: 'pending' }
    const events: Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }> = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    for (let page = 0; page < 100; page += 1) {
      const history = await this.api.sessions.history(request({
        sessionId: summary.sessionId,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }))
      if (!history.result.ok) return { outcome: 'pending' }
      events.push(...history.result.value.events)
      const oldestTime = history.result.value.events.reduce<number | undefined>((oldest, entry) => {
        const time = entry.event.time
        return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
      }, undefined)
      if (!history.result.value.hasMore || (oldestTime !== undefined && oldestTime <= since)) {
        reachedExecutionBoundary = true
        break
      }
      const oldestSeq = history.result.value.events.reduce<number | undefined>((oldest, entry) => {
        const seq = entry.event.seq
        return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
      }, undefined)
      if (oldestSeq === undefined || oldestSeq === beforeSeq) return { outcome: 'pending' }
      beforeSeq = oldestSeq
    }
    if (!reachedExecutionBoundary) return { outcome: 'pending' }
    const turnEnd = events
      .filter(entry => entry.event.type === 'turn/end' && (
        since <= 0 || (typeof entry.event.time === 'number' && entry.event.time >= since)
      ))
      .sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0]
    if (turnEnd === undefined) {
      // Complete scan, no match: remember the head so later ticks probe only.
      if (newestSeq !== undefined) this.scanMemos.set(sessionId, newestSeq)
      return { outcome: 'pending' }
    }
    this.scanMemos.delete(sessionId)
    const outcome = turnEndOutcome(turnEnd.event.data)
    const answer = extractSummary(events, since)
    if (outcome === 'failed') return { outcome: 'failed', error: 'agent turn ended with an error', ...(answer === undefined ? {} : { summary: answer }) }
    if (outcome === 'cancelled') return { outcome: 'cancelled', error: 'execution was stopped' }
    return { outcome: 'succeeded', ...(answer === undefined ? {} : { summary: answer }) }
  }
}
