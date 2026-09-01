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

  it('marks event-created tasks with the event origin, approved only when autoRun', async () => {
    // autoRun off (the review flow): the task is event-origin and unapproved,
    // so it lands in the backlog and can never run until a human approves it.
    const review = createHttpEventSource()
    const reviewMapping = await review.map(req(), { title: 'Alert' })
    expect(reviewMapping.input.source).toBe('event')
    expect(reviewMapping.input.approved).toBe(false)
    // autoRun on (immediate execution requested by the caller): approved.
    const run = createHttpEventSource({ autoRun: true })
    const runMapping = await run.map(req(), { title: 'Alert' })
    expect(runMapping.input.source).toBe('event')
    expect(runMapping.input.approved).toBe(true)
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
