/**
 * Plan-phase capture and hand-off: extract the plan a plan-model turn produced
 * from the raw session history events the runner already scans, and build the
 * prompts that drive the plan → work transition. Pure and framework-free so it
 * is unit-testable in isolation, mirroring the result-summary capture.
 *
 * The authoritative plan is the `exit_plan_mode` tool call the plan model made
 * (its `plan` argument IS the complete, structured plan, even when the review
 * that normally follows it could not open for an owned execution session).
 * When the model never called the tool, the newest text-bearing assistant
 * message of the plan turn is used instead, so a plan produced as a plain
 * final message still hands off to the worker.
 */

/** Maximum characters of the plan retained for the work hand-off and ledger. */
export const PLAN_LIMIT = 20_000

/** The plan-phase prompt: the task prompt plus an instruction that keeps the plan turn self-contained. */
export function buildPlanPrompt(task: { prompt: string; title: string }): string {
  const subject = task.prompt !== '' ? task.prompt : task.title
  return `You are planning this task in plan mode. Explore and design before presenting your plan, then present a complete, concrete, actionable plan as your FINAL MESSAGE — no preamble, no questions. Do NOT call exit_plan_mode; the orchestrator hands the plan to the worker automatically.

Task:
${subject}`
}

/** The work-phase prompt: the approved plan plus the original task, executed by the worker model. */
export function buildWorkPrompt(plan: string, task: { prompt: string; title: string }): string {
  const subject = task.prompt !== '' ? task.prompt : task.title
  return `Execute the approved plan below to complete the task. Follow the plan step by step; do not re-plan. Report what you did when you finish.

# Approved plan
${plan}

# Task
${subject}`
}

/** Structural view of one history entry; tolerant of unknown/future shapes. */
export interface PlanEvent {
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: unknown
  }
}

/** Concatenated text of an `assistant/message` event's message content, if any. */
function messageText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as Record<string, unknown>
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text !== '') {
      parts.push(candidate.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** The `plan` argument of an `exit_plan_mode` tool call, when parseable. */
function exitPlanArgument(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (record.name !== 'exit_plan_mode') return undefined
  if (typeof record.arguments !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(record.arguments)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const plan = (parsed as Record<string, unknown>).plan
    return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
  } catch {
    return undefined
  }
}

/** Bound a captured plan to {@link PLAN_LIMIT} with an ellipsis. */
function boundPlan(text: string): string {
  return text.length > PLAN_LIMIT ? `${text.slice(0, PLAN_LIMIT)}…` : text
}

/**
 * Extract the plan one plan turn produced. The newest `exit_plan_mode` tool
 * call's `plan` argument wins (the plan model's structured plan); otherwise
 * the newest text-bearing `assistant/message` is the plan. `since` drops
 * events that predate the plan phase (a shared session could page into an
 * earlier turn). Returns undefined when the turn produced no plan at all.
 */
export function extractPlan(events: readonly PlanEvent[], since = 0): string | undefined {
  let fromTool: { key: number; plan: string } | undefined
  let fromMessage: { key: number; text: string } | undefined
  for (const entry of events) {
    const event = entry?.event
    if (event === undefined) continue
    const time = typeof event.time === 'number' ? event.time : undefined
    if (since > 0 && time !== undefined && time < since) continue
    const key = typeof event.seq === 'number' ? event.seq : time ?? 0
    if (event.type === 'tool/call') {
      const plan = exitPlanArgument(event.data)
      if (plan !== undefined && (fromTool === undefined || key > fromTool.key)) {
        fromTool = { key, plan }
      }
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data)
      if (text !== undefined && (fromMessage === undefined || key > fromMessage.key)) {
        fromMessage = { key, text }
      }
    }
  }
  if (fromTool !== undefined) return boundPlan(fromTool.plan)
  if (fromMessage !== undefined) return boundPlan(fromMessage.text)
  return undefined
}

/**
 * Whether the plan turn is currently stuck awaiting the `exit_plan_mode`
 * human review: the newest events show an `exit_plan_mode` tool call whose
 * result never landed. For a board-owned session the review normally cannot
 * open (the calling agent is not the interactive runtime root, so the call
 * fails and the model finishes the turn), but when it can open no human may
 * answer — the runner then auto-extracts the plan and cancels the turn.
 */
export function planAwaitingReview(events: readonly PlanEvent[], since = 0): boolean {
  let newestToolCall: { key: number } | undefined
  let newestResult: { key: number } | undefined
  for (const entry of events) {
    const event = entry?.event
    if (event === undefined) continue
    const time = typeof event.time === 'number' ? event.time : undefined
    if (since > 0 && time !== undefined && time < since) continue
    const key = typeof event.seq === 'number' ? event.seq : time ?? 0
    if (event.type === 'tool/call' && exitPlanArgument(event.data) !== undefined) {
      if (newestToolCall === undefined || key > newestToolCall.key) newestToolCall = { key }
    } else if (event.type === 'tool/result' && newestToolCall !== undefined && key > newestToolCall.key) {
      if (newestResult === undefined || key > newestResult.key) newestResult = { key }
    }
  }
  return newestToolCall !== undefined && (newestResult === undefined || newestResult.key < newestToolCall.key)
}
