/**
 * Host-side open-question watcher: which execution session is currently
 * waiting for the human to answer an `ask_user_question`.
 *
 * DSH exposes open questions only on the events mux stream — the
 * `question/requested` frame (an agent asked; the session's turn is blocked
 * until the human answers) and the `question/resolved` frame (answered or
 * cancelled). This watcher subscribes to the mux stream and keeps one
 * volatile record per session with an open ask. It is deliberately separate
 * from the ledger: an ask opening and closing is a live session fact, never a
 * durable board transition, so nothing here bumps a revision or writes a
 * file. A mux-open replays still-pending questions, which also recovers the
 * board's view after a Host restart.
 *
 * Fail-soft by design: a deployment without the events gateway (or a mux
 * stream that drops) disables the indicator, never the board — the watcher
 * logs once and retries with a bounded delay while the service lives.
 */
import type { ApiProxy, MuxFrame, RpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'

/** Delay before re-subscribing after the mux stream drops. */
const RECONNECT_DELAY_MS = 5_000

/** Open question text is only a hint; keep SSE frames and snapshots light. */
const SUMMARY_MAX_LENGTH = 200

/** One session's open ask, as the watcher tracks it. */
interface OpenAsk {
  /** The question frame's stable logical id; resolutions echo it. */
  rpcId: RpcId
  /** When the question was asked (ms epoch). */
  askedAt: number
  /** How many questions the batch carries. */
  count: number
  /** The batch's first question text, truncated. */
  summary?: string
}

/** The readonly view the Host service publishes for one session. */
export interface HostOpenQuestion {
  askedAt: number
  count: number
  summary?: string
}

function truncate(text: string): string {
  return text.length <= SUMMARY_MAX_LENGTH ? text : `${text.slice(0, SUMMARY_MAX_LENGTH)}…`
}

export class OpenQuestionWatcher {
  /** sessionId → its open ask (at most one: an ask blocks the turn). */
  private readonly open = new Map<string, OpenAsk>()
  private readonly listeners = new Set<() => void>()
  private readonly controller = new AbortController()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private disposed = false
  private readonly now: () => number
  private readonly warn: (message: string) => void

  constructor(
    private readonly api: Pick<ApiProxy, 'events'>,
    options: {
      /** Clock (tests). */
      now?: () => number
      /** Failure sink; defaults to console.warn. */
      warn?: (message: string) => void
    } = {},
  ) {
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message: string) => console.warn(`[dsh-all-tasks] ${message}`))
  }

  /** Begin watching. Idempotent; a dispose never resurrects the watcher. */
  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    if (this.api.events?.mux === undefined) {
      this.warn('session question watching is unavailable (no events gateway); the board keeps running')
      return
    }
    void this.consume()
  }

  /** Subscribe to open-question changes (requested/resolved/pruned). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The open ask of one session, or undefined when it is not waiting. */
  get(sessionId: string): HostOpenQuestion | undefined {
    const open = this.open.get(sessionId)
    if (open === undefined) return undefined
    return { askedAt: open.askedAt, count: open.count, ...(open.summary === undefined ? {} : { summary: open.summary }) }
  }

  /**
   * Drop entries for sessions that no longer matter (their execution settled
   * or was paused without a resolution frame reaching us). Returns whether
   * anything was dropped, so callers can decide whether to notify.
   */
  prune(keepSessionIds: ReadonlySet<string>): boolean {
    let changed = false
    for (const sessionId of [...this.open.keys()]) {
      if (!keepSessionIds.has(sessionId)) {
        this.open.delete(sessionId)
        changed = true
      }
    }
    return changed
  }

  stop(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.controller.abort()
    this.open.clear()
    this.listeners.clear()
  }

  private async consume(): Promise<void> {
    const signal = this.controller.signal
    try {
      for await (const frame of this.api.events.mux(muxRequest(), signal)) {
        this.accept(frame)
      }
      this.scheduleRetry('mux stream ended')
    } catch (error) {
      if (signal.aborted) return
      this.warn(`session question mux stream failed: ${error instanceof Error ? error.message : String(error)}`)
      this.scheduleRetry('mux stream failed')
    }
  }

  private accept(frame: RpcRequest<MuxFrame>): void {
    const payload = frame.payload
    if (payload.type === 'question/requested') {
      if (payload.questions.length === 0) return
      const existing = this.open.get(payload.sessionId)
      const summary = payload.questions[0]?.question
      const next: OpenAsk = {
        rpcId: frame.rpcId,
        askedAt: this.now(),
        count: payload.questions.length,
        ...(summary === undefined || summary === '' ? {} : { summary: truncate(summary) }),
      }
      if (existing !== undefined && existing.rpcId === next.rpcId
        && existing.count === next.count && existing.summary === next.summary) return
      this.open.set(payload.sessionId, next)
      this.emit()
      return
    }
    if (payload.type === 'question/resolved') {
      const current = this.open.get(payload.sessionId)
      if (current !== undefined && current.rpcId === payload.questionRpcId) {
        this.open.delete(payload.sessionId)
        this.emit()
      }
    }
    // Every other mux frame (session/event, approvals, projections, …) is not
    // this watcher's business.
  }

  private scheduleRetry(reason: string): void {
    if (this.disposed || this.retryTimer !== undefined) return
    this.warn(`session question watching will retry in ${RECONNECT_DELAY_MS / 1000}s (${reason})`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.disposed || !this.running) return
      void this.consume()
    }, RECONNECT_DELAY_MS)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** One empty mux-open request (the stream takes no meaningful payload). */
function muxRequest(): RpcRequest<{ since?: Record<string, number> }> {
  return { rpcId: `all-tasks-questions-${crypto.randomUUID()}` as RpcId, payload: {} }
}
