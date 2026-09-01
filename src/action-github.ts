/**
 * action-github: an outbound result-side action that posts the settlement
 * summary back to GitHub — a comment on an issue/PR, or a comment on a commit.
 * The target (repo + issue number or commit SHA) is static config for now;
 * wiring dynamic commit/PR context from the triggering event is a later
 * data-passing feature.
 */
import type { Action } from './core/actions.ts'

export const GITHUB_ACTION_ID = 'github'

export interface GithubActionConfig {
  /** Env var holding a GitHub PAT (or installation token). */
  tokenEnv?: string
  /** GitHub API base (default https://api.github.com). */
  apiBase?: string
  /** owner/repo to act on. */
  repo?: string
  /** Comment on this issue/PR number (issues and PRs share the issues endpoint). */
  issueNumber?: number
  /** Comment on this commit SHA. */
  commitSha?: string
}

export interface GithubActionDeps {
  fetchFn?: typeof fetch
  env?: NodeJS.ProcessEnv
}

export function createGithubAction(deps: GithubActionDeps = {}): Action {
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const env = deps.env ?? process.env
  return {
    id: GITHUB_ACTION_ID,
    when: ['always'],
    async run(ctx) {
      const config = (ctx.config ?? {}) as GithubActionConfig
      const tokenEnv = config.tokenEnv?.trim()
      const token = tokenEnv === undefined || tokenEnv === '' ? undefined : env[tokenEnv]
      if (token === undefined || token === '') throw new Error('action github: token is required')
      const repo = config.repo?.trim()
      if (repo === undefined || repo === '') return
      const apiBase = (config.apiBase?.trim() || 'https://api.github.com').replace(/\/+$/, '')
      const body = `**${ctx.task.title}** settled as \`${ctx.execution.result ?? 'unknown'}\`.\n\n${ctx.execution.summary ?? ''}\n\nSession: \`${ctx.sessionId ?? 'n/a'}\``
      let url: string
      if (config.issueNumber !== undefined) {
        url = `${apiBase}/repos/${repo}/issues/${config.issueNumber}/comments`
      } else if (config.commitSha !== undefined && config.commitSha !== '') {
        url = `${apiBase}/repos/${repo}/commits/${config.commitSha}/comments`
      } else {
        return
      }
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`action github POST ${url} returned ${response.status}`)
    },
  }
}
