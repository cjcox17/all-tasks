import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { EventRequest } from '../src/core/events.ts'
import { createGithubEventSource, GITHUB_EVENT_PATH } from '../src/event-github.ts'

function req(headers: Record<string, string> = {}): EventRequest {
  return { method: 'POST', url: GITHUB_EVENT_PATH, headers }
}

const payload = {
  action: 'completed',
  workflow_run: {
    head_branch: 'main',
    conclusion: 'failure',
    name: 'CI',
  },
  workflow: { name: 'CI' },
  repository: { full_name: 'cjcox17/wyx', name: 'wyx' },
  sha: 'abc123',
}

describe('event-github', () => {
  it('maps a workflow_run failure into a fix-oriented task', async () => {
    const source = createGithubEventSource({ repoWorkspaces: { 'cjcox17/wyx': 'ws-wyx' }, autoRun: true })
    const mapping = await source.map(req({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'deliv-1' }), payload)
    expect(mapping.autoRun).toBe(true)
    expect(mapping.dedupeKey).toBe('deliv-1')
    expect(mapping.input.workspaceId).toBe('ws-wyx')
    expect(mapping.input.title).toContain('workflow_run')
    expect(mapping.input.prompt).toContain('cjcox17/wyx')
    expect(mapping.input.prompt).toContain('failure')
    expect(mapping.input.prompt).toContain('Fix the issue and commit the fix')
    expect(mapping.input.source).toBe('event')
  })

  it('falls back to the default workspace for unmapped repos', async () => {
    const source = createGithubEventSource({ repoWorkspaces: {}, defaultWorkspaceId: 'ws-default' })
    const mapping = await source.map(req({ 'x-github-event': 'push' }), payload)
    expect(mapping.input.workspaceId).toBe('ws-default')
    expect(mapping.autoRun).toBe(false)
  })

  it('verifies the HMAC-SHA256 signature', async () => {
    const secret = 's3cret'
    const raw = JSON.stringify(payload)
    const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
    const source = createGithubEventSource({ secretEnv: 'GH_SECRET' }, { GH_SECRET: secret })
    expect(await source.verify(req({ 'x-hub-signature-256': signature }), raw)).toBe(true)
    expect(await source.verify(req({ 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }), raw)).toBe(false)
    expect(await source.verify(req({}), raw)).toBe(false)
  })

  it('allows requests when no secret is configured', async () => {
    const source = createGithubEventSource({}, {})
    expect(await source.verify(req(), 'body')).toBe(true)
  })
})
