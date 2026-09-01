/**
 * Host title-suggestion: run a short backend DSH session that turns a task's
 * run prompt into a title. The session is real but stays in the background of
 * the creation workflow — it is composed like any execution session (the
 * task's model pin is applied when given, but no workspace/preset pins), queued
 * with a strict one-shot instruction, and settled through the runner's normal
 * inspection. The single answer is sanitized; a timeout or an unusable answer
 * yields undefined so the browser falls back to the prompt-derived heuristic
 * title instead of blocking task creation.
 *
 * The generator session is deliberately short-lived: one turn, then idle. DSH
 * offers no session-delete RPC, so the session remains in the session list
 * under an identifiable name; users can remove it there if they wish.
 */
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { sanitizeGeneratedTitle, titleInstruction } from './core/title.ts'
import { createTask, normalizeModelSelection, type TaskModelSelection } from './core/tasks.ts'
import { HostExecutionRunner, SessionLaunchError } from './host-runner.ts'

/** How long a title-generation turn may take before the session is cancelled. */
export const TITLE_GENERATION_TIMEOUT_MS = 60_000

/** How long to wait between settlement probes while the turn runs. */
const TITLE_POLL_MS = 1_500

/** Display name of the generator session (identifiable in the session list). */
export const TITLE_GENERATOR_SESSION_TITLE = 'All Tasks · title'

/** Bound on the prompt/description text embedded in the generation instruction. */
export const TITLE_INPUT_BOUND = 16 * 1024

/** One title-suggestion request from the browser. */
export interface TitleSuggestionRequest {
  /** The task's run prompt (the title source of truth). */
  prompt: string
  /** Optional task description providing extra context. */
  description?: string
  /** Optional model pin; absent uses the deployment default. */
  model?: TaskModelSelection
}

function rpc<T>(payload: T) {
  return { rpcId: `all-tasks-${crypto.randomUUID()}` as RpcId, payload }
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** Gate an optional model selection from the wire (exact keys, bounded ids). */
function modelPayload(value: unknown): TaskModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const selection = value as Record<string, unknown>
  if (Object.keys(selection).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) return undefined
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
  return normalizeModelSelection(selection)
}

/**
 * Gate a title-suggestion request from the wire; undefined when rejected.
 * At least one of the prompt/description texts must be non-blank, and every
 * field is bounded so a hostile body cannot bloat the generation prompt.
 */
export function parseTitleSuggestionRequest(value: unknown): TitleSuggestionRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['prompt', 'description', 'model'].includes(key))) return undefined
  const prompt = boundedString(input.prompt, TITLE_INPUT_BOUND)
  if (prompt === undefined) return undefined
  const description = input.description === undefined ? undefined : boundedString(input.description, TITLE_INPUT_BOUND)
  if (description === undefined && input.description !== undefined) return undefined
  const model = input.model === undefined ? undefined : modelPayload(input.model)
  if (model === undefined && input.model !== undefined) return undefined
  if (prompt.trim() === '' && (description ?? '').trim() === '') return undefined
  return { prompt, ...(description === undefined ? {} : { description }), ...(model === undefined ? {} : { model }) }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Generate a title for a task from its run prompt through a short backend
 * session. The session reuses the runner's launch pipeline (model pin applied
 * when given; workspace/preset absent), is prompted with the strict
 * {@link titleInstruction}, and is settled via the runner's normal inspection.
 * The generated answer is sanitized to a single bounded line.
 * @param runner - the execution runner (launch + settlement inspection).
 * @param api - the host API proxy (used to cancel the session on timeout).
 * @param request - the prompt/description/model to generate from.
 * @param now - clock instant (ms epoch); injectable for tests.
 * @param timeoutMs - bound on the whole generation; a still-running session is
 *   cancelled on expiry.
 * @returns the generated title, or undefined when the turn failed, timed out,
 *   or produced no usable answer (the caller falls back to
 *   {@link fallbackTitle}).
 */
export async function suggestTaskTitle(
  runner: HostExecutionRunner,
  api: ApiProxy,
  request: TitleSuggestionRequest,
  now: () => number = Date.now,
  timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS,
): Promise<string | undefined> {
  const task = createTask({
    title: TITLE_GENERATOR_SESSION_TITLE,
    description: '',
    prompt: titleInstruction(request.prompt, request.description ?? ''),
    ...(request.model === undefined ? {} : { model: request.model }),
  }, now(), 'title-generation')
  let sessionId: string | undefined
  try {
    try {
      sessionId = await runner.launch(task)
    } catch (error) {
      // A launch failure after creation still leaves a session behind; carry
      // its id so the finally block can halt it.
      if (error instanceof SessionLaunchError) sessionId = error.sessionId
      throw error
    }
    const deadline = now() + timeoutMs
    for (;;) {
      const result = await runner.inspect(sessionId)
      if (result.outcome !== 'pending') {
        if (result.outcome !== 'succeeded') return undefined
        return result.summary === undefined
          ? undefined
          : sanitizeGeneratedTitle(result.summary)
      }
      if (now() >= deadline) return undefined
      await delay(TITLE_POLL_MS)
    }
  } finally {
    // Best-effort: stop a still-running generator turn on every exit path so
    // the backend session does not keep billing after we give up. Cancelling
    // an idle (already settled) session is an acknowledged no-op.
    if (sessionId !== undefined) {
      await api.sessions.cancel(rpc({ sessionId: sessionId as never })).catch(() => {})
    }
  }
}
