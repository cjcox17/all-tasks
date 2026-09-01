import { describe, expect, it } from 'vitest'
import type { EventRequest } from '../src/core/events.ts'
import { createHttpEventSource, HTTP_EVENT_PATH } from '../src/event-http.ts'

function req(headers: Record<string, string> = {}): EventRequest {
  return { method: 'POST', url: HTTP_EVENT_PATH, headers }
}

describe('event-http', () => {
  it('maps a JSON object into a task with a derived title and workspace pin', async () => {
    const source = createHttpEventSource({ autoRun: true, workspaceId: 'ws-1' })
    const mapping = await source.map(req(), { title: 'Build failed', repo: 'wyx', log: 'boom' })
    expect(mapping.autoRun).toBe(true)
    expect(mapping.input.workspaceId).toBe('ws-1')
    expect(mapping.input.title).toBe('Build failed')
    expect(mapping.input.prompt).toContain('"repo": "wyx"')
    expect(mapping.input.prompt).toContain('"log": "boom"')
  })

  it('derives a dedupe key from the header and defaults autoRun to false', async () => {
    const source = createHttpEventSource()
    const mapping = await source.map(req({ 'x-dsh-event-id': 'evt-1' }), 'plain text')
    expect(mapping.dedupeKey).toBe('evt-1')
    expect(mapping.autoRun).toBe(false)
    expect(mapping.input.prompt).toBe('plain text')
  })

  it('verifies a bearer token against the configured env var', async () => {
    const source = createHttpEventSource({ tokenEnv: 'EVT_TOKEN' }, { EVT_TOKEN: 'secret' })
    expect(await source.verify(req({ authorization: 'Bearer secret' }), '')).toBe(true)
    expect(await source.verify(req({ authorization: 'Bearer wrong' }), '')).toBe(false)
    expect(await source.verify(req({ 'x-dsh-events-token': 'secret' }), '')).toBe(true)
  })

  it('allows requests when no token is configured', async () => {
    const source = createHttpEventSource({}, {})
    expect(await source.verify(req(), '')).toBe(true)
  })
})
