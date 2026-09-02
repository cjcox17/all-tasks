import { describe, expect, it } from 'vitest'
import { ActionRegistry, type Action } from '../src/core/actions.ts'
import { EventSourceRegistry, type EventSource } from '../src/core/events.ts'
import { buildIntegrationsSnapshot } from '../src/integrations-status.ts'

function eventSource(id: string, path: string, method: 'POST' | 'GET' = 'POST'): EventSource {
  return {
    id,
    method,
    path,
    verify: () => true,
    map: () => ({ input: { title: 't', description: '', prompt: 'p' }, autoRun: false }),
  }
}

function action(id: string, when: readonly Action['when'][number][]): Action {
  return { id, when: [...when], run: () => {} }
}

describe('buildIntegrationsSnapshot', () => {
  it('lists every registered event source with its mount facts and resolved config', () => {
    const events = new EventSourceRegistry()
    events.register(eventSource('http', '/api/all-tasks/events/http'))
    events.register(eventSource('github', '/api/all-tasks/events/github'))
    const actions = new ActionRegistry()
    actions.register(action('http', ['always']))

    const snapshot = buildIntegrationsSnapshot(events, actions, () => ({
      events: { http: { tokenEnv: 'DSH_EVENTS_TOKEN', autoRun: true } },
      actions: { http: { url: 'https://example.com/hook' } },
    }))

    expect(snapshot.events).toHaveLength(2)
    expect(snapshot.events[0]).toEqual({
      id: 'http',
      method: 'POST',
      path: '/api/all-tasks/events/http',
      config: { tokenEnv: 'DSH_EVENTS_TOKEN', autoRun: true },
    })
    // The github source has no config slice: absent keys are an empty object.
    expect(snapshot.events[1].config).toEqual({})
    expect(snapshot.actions).toEqual([
      { id: 'http', when: ['always'], config: { url: 'https://example.com/hook' } },
    ])
  })

  it('copies the action trigger outcomes instead of aliasing the registry array', () => {
    const events = new EventSourceRegistry()
    const actions = new ActionRegistry()
    const source: Action = { id: 'spawn', when: ['succeeded'], run: () => {} }
    actions.register(source)

    const snapshot = buildIntegrationsSnapshot(events, actions, () => undefined)
    // The snapshot's `when` is a fresh array, not an alias of the registry
    // action's (readonly) list.
    expect(snapshot.actions[0]!.when).not.toBe(source.when)
    expect(snapshot.actions[0]!.when).toEqual(['succeeded'])
  })

  it('tolerates a missing config source and unknown config shapes', () => {
    const events = new EventSourceRegistry()
    events.register(eventSource('slack', '/api/all-tasks/events/slack'))
    const actions = new ActionRegistry()

    const snapshot = buildIntegrationsSnapshot(events, actions, () => undefined)
    expect(snapshot.events[0]!.config).toEqual({})
    expect(snapshot.actions).toEqual([])
  })

  it('reads the config fresh per call (live settings edits are reflected)', () => {
    const events = new EventSourceRegistry()
    events.register(eventSource('http', '/api/all-tasks/events/http'))
    const actions = new ActionRegistry()
    let eventsConfig: Record<string, unknown> = { tokenEnv: '' }
    const getConfig = (): { events: Record<string, unknown> } => ({ events: { http: eventsConfig } })

    const first = buildIntegrationsSnapshot(events, actions, getConfig)
    expect(first.events[0]!.config).toEqual({ tokenEnv: '' })
    eventsConfig = { tokenEnv: 'DSH_EVENTS_TOKEN', workspaceId: 'w1' }
    const second = buildIntegrationsSnapshot(events, actions, getConfig)
    expect(second.events[0]!.config).toEqual({ tokenEnv: 'DSH_EVENTS_TOKEN', workspaceId: 'w1' })
  })
})
