import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EventRequest } from '../src/core/events.ts'
import { createSlackEventSource, SLACK_EVENT_PATH } from '../src/event-slack.ts'

function req(headers: Record<string, string> = {}): EventRequest {
  return { method: 'POST', url: SLACK_EVENT_PATH, headers }
}

describe('event-slack', () => {
  it('verifies the X-Slack-Signature', async () => {
    const secret = 's3cret'
    const raw = '{"type":"event_callback"}'
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
    const source = createSlackEventSource({ signingSecretEnv: 'SLACK_SECRET' }, { SLACK_SECRET: secret })
    expect(await source.verify(req({ 'x-slack-signature': signature, 'x-slack-request-timestamp': ts }), raw)).toBe(true)
    expect(await source.verify(req({ 'x-slack-signature': 'v0=' + '0'.repeat(64), 'x-slack-request-timestamp': ts }), raw)).toBe(false)
    expect(await source.verify(req({}), raw)).toBe(false)
  })

  it('answers the URL-verification challenge', () => {
    const source = createSlackEventSource()
    expect(source.respond?.({ type: 'url_verification', challenge: 'abc' })).toEqual({ status: 200, body: { challenge: 'abc' } })
    expect(source.respond?.({ type: 'event_callback' })).toBeUndefined()
  })

  it('maps an event_callback message into a task', async () => {
    const source = createSlackEventSource({ workspaceId: 'ws-1', autoRun: true })
    const mapping = await source.map(req(), {
      type: 'event_callback',
      event: { type: 'message', text: 'fix the build', channel: 'C1', user: 'U1' },
    })
    expect(mapping.autoRun).toBe(true)
    expect(mapping.input.workspaceId).toBe('ws-1')
    expect(mapping.input.prompt).toBe('fix the build')
    expect(mapping.input.title).toContain('C1')
    expect(mapping.input.source).toBe('event')
  })
})
