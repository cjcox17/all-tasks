/**
 * Integrations status: the read-only snapshot behind the Events and Actions
 * sidebar panels. Pure and framework-free — the Host route layer feeds it the
 * registered registries and the resolved plugin config, so the browser never
 * hardcodes which sources/actions exist or where they are mounted.
 */
import type { ActionRegistry } from './core/actions.ts'
import type { EventSourceRegistry } from './core/events.ts'
import type { AllTasksIntegrationsSnapshot, ActionStatus, EventSourceStatus } from './protocol.ts'

/** The resolved config the status builder reads sources/actions slices from. */
export interface IntegrationsConfigSource {
  events?: Record<string, unknown>
  actions?: Record<string, unknown>
}

function configSlice(
  root: Record<string, unknown> | undefined,
  id: string,
): Record<string, unknown> {
  const slice = root?.[id]
  return typeof slice === 'object' && slice !== null && !Array.isArray(slice)
    ? slice as Record<string, unknown>
    : {}
}

/**
 * Build the Events/Actions panel snapshot from the live registries and the
 * resolved config. Every registered source/action is listed with its mount
 * facts (method/path for sources, trigger outcomes for actions) and its own
 * resolved settings slice. Config carries env-var *names* only — never secret
 * values — so the payload is safe to serve to the browser.
 * @param events - the registered event-source registry.
 * @param actions - the registered action registry.
 * @param getConfig - resolves the current plugin config at call time (live
 * settings edits are reflected without a restart).
 */
export function buildIntegrationsSnapshot(
  events: EventSourceRegistry,
  actions: ActionRegistry,
  getConfig: () => IntegrationsConfigSource | undefined,
): AllTasksIntegrationsSnapshot {
  const config = getConfig() ?? {}
  const eventStatus: EventSourceStatus[] = events.all().map(source => ({
    id: source.id,
    method: source.method,
    path: source.path,
    config: configSlice(config.events, source.id),
  }))
  const actionStatus: ActionStatus[] = actions.all().map(action => ({
    id: action.id,
    when: [...action.when],
    config: configSlice(config.actions, action.id),
  }))
  return { events: eventStatus, actions: actionStatus }
}
