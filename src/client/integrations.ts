/**
 * Integrations transport: the read-only fetch behind the Events and Actions
 * sidebar panels. The Host is the authority on which sources/actions exist;
 * this module only asks for the status snapshot and renders it.
 */
import { ALL_TASKS_API_PREFIX, type AllTasksIntegrationsSnapshot } from '../protocol.ts'

const REQUEST_TIMEOUT_MS = 15_000

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `all-tasks request failed: ${response.status}`)
  return body
}

/**
 * Fetch the registered event sources and actions with their mount facts and
 * resolved config. Rejects on non-2xx (including the fence's 403), so the
 * panels can surface a retryable error.
 */
export async function fetchIntegrations(): Promise<AllTasksIntegrationsSnapshot> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    return await readJson<AllTasksIntegrationsSnapshot>(
      await fetch(`${ALL_TASKS_API_PREFIX}/integrations`, {
        cache: 'no-store',
        signal: controller.signal,
        // Browser-signal tripwire marker (see host-routes.ts); the loopback
        // socket + Host + origin-equality checks carry the real authority.
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    )
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`all-tasks integrations request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`)
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
  }
}
