/**
 * Browser title-suggestion transport: asks the Host to generate a task title
 * from the run prompt through a short backend session. Failures (offline,
 * timeouts, rejected requests, no usable answer) throw so the new-task modal
 * falls back to the prompt-derived heuristic title instead of blocking
 * creation. The suggestion is advisory only — the ledger transition still
 * happens through the normal `create` action with the resulting title.
 */
import type { TaskModelSelection } from '../core/tasks.ts'
import { ALL_TASKS_API_PREFIX } from '../protocol.ts'

/** One title-suggestion request sent to the Host. */
export interface TitleSuggestionRequest {
  /** The task's run prompt (the title source of truth). */
  prompt: string
  /** Optional task description providing extra context. */
  description?: string
  /** Optional model pin; absent uses the deployment default. */
  model?: TaskModelSelection
}

/** How long a title-suggestion call may take before the browser gives up. */
export const TITLE_SUGGEST_TIMEOUT_MS = 45_000

/**
 * Request a generated title from the Host.
 * @returns the generated title.
 * @throws when the Host is unavailable, the request is rejected, or no usable
 *   title came back (the caller falls back to the heuristic title).
 */
export async function suggestTaskTitleClient(request: TitleSuggestionRequest): Promise<string> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => { controller.abort() }, TITLE_SUGGEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${ALL_TASKS_API_PREFIX}/title-suggest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    const body = await response.json() as { title?: unknown; error?: string }
    if (!response.ok) throw new Error(body.error ?? `all-tasks title suggestion failed: ${response.status}`)
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw new Error('all-tasks title suggestion returned no title')
    }
    return body.title
  } finally {
    globalThis.clearTimeout(timeout)
  }
}
