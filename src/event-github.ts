/**
 * event-github: the GitHub webhook event source. Verifies the HMAC-SHA256
 * signature, maps a repository full name to a workspace, and turns the webhook
 * payload into a fix-oriented task prompt. Dedupes on X-GitHub-Delivery.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { EventMapping, EventRequest, EventSource } from './core/events.ts'

export const GITHUB_EVENT_ID = 'github'
export const GITHUB_EVENT_PATH = '/api/task-board/events/github'

const PROMPT_LIMIT = 64 * 1024
const TITLE_LIMIT = 256

export interface GithubEventConfig {
  /** Env var holding the webhook secret (HMAC-SHA256, X-Hub-Signature-256). */
  secretEnv?: string
  /** Map repository full name (owner/repo) → workspace id. */
  repoWorkspaces?: Record<string, string>
  /** Workspace for repos not present in `repoWorkspaces`. */
  defaultWorkspaceId?: string
  /** Run the created task immediately (false = land in backlog). */
  autoRun?: boolean
}

function hexEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function field(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function buildPrompt(event: string, repo: string | undefined, workflow: string | undefined, branch: string | undefined, sha: string | undefined, conclusion: string | undefined, payload: unknown): string {
  const lines = [
    `A GitHub ${event} event arrived${repo !== undefined ? ` for ${repo}` : ''}.`,
    workflow !== undefined ? `Workflow: ${workflow}` : undefined,
    branch !== undefined ? `Branch: ${branch}` : undefined,
    sha !== undefined ? `Commit: ${sha}` : undefined,
    conclusion !== undefined ? `Conclusion: ${conclusion}` : undefined,
    '',
    'Fix the issue and commit the fix. Full webhook payload:',
    '',
    JSON.stringify(payload, null, 2),
  ]
  const text = lines.filter((line): line is string => line !== undefined).join('\n')
  return text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT)}…` : text
}

export function createGithubEventSource(config: GithubEventConfig = {}, env: NodeJS.ProcessEnv = process.env): EventSource {
  return {
    id: GITHUB_EVENT_ID,
    method: 'POST',
    path: GITHUB_EVENT_PATH,
    verify(request, rawBody) {
      const secretEnv = config.secretEnv?.trim()
      if (secretEnv === undefined || secretEnv === '') return true
      const secret = env[secretEnv]
      if (secret === undefined || secret === '') return true
      const signature = stringHeader(request.headers['x-hub-signature-256'])
      if (signature === undefined || !signature.startsWith('sha256=')) return false
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
      return hexEqual(signature.slice('sha256='.length), expected)
    },
    map(request, body) {
      const record = asRecord(body)
      const event = stringHeader(request.headers['x-github-event']) ?? 'event'
      const repository = asRecord(record.repository)
      const fullName = field(repository, 'full_name') ?? field(repository, 'name')
      const workspaceId = (fullName !== undefined ? config.repoWorkspaces?.[fullName] : undefined) ?? config.defaultWorkspaceId
      const workflow = asRecord(record.workflow)
      const workflowRun = asRecord(record.workflow_run)
      const action = field(record, 'action')
      const conclusion = field(record, 'conclusion') ?? field(workflowRun, 'conclusion')
      const branch = field(workflowRun, 'head_branch')
      const sha = field(record, 'sha')
      const workflowName = field(workflow, 'name')

      const title = ['GitHub', event, fullName, workflowName, action, conclusion]
        .filter((value): value is string => value !== undefined)
        .join(' · ')
        .slice(0, TITLE_LIMIT)

      const prompt = buildPrompt(event, fullName, workflowName, branch, sha, conclusion, record)
      const delivery = stringHeader(request.headers['x-github-delivery'])

      const mapping: EventMapping = {
        input: {
          title,
          description: '',
          prompt,
          ...(workspaceId === undefined || workspaceId === '' ? {} : { workspaceId }),
        },
        autoRun: config.autoRun === true,
        ...(delivery === undefined ? {} : { dedupeKey: delivery }),
      }
      return mapping
    },
  }
}
