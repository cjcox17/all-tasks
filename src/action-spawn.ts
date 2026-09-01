/**
 * action-spawn: an internal result-side action that turns a settled task's
 * final answer into a new task. Loose JSON parsing — the triage task is
 * instructed to output either a task directive ({workspace, title, prompt}) or
 * {skip: true}. The new task is created (and optionally run) via the Host
 * dispatcher's spawn capability.
 */
import type { Action } from './core/actions.ts'
import type { NewTaskInput } from './core/tasks.ts'

export const SPAWN_ACTION_ID = 'spawn'

export interface SpawnDirective {
  input: NewTaskInput
  autoRun?: boolean
}

/** The first balanced JSON object in the text, or undefined when none parses. */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through to a substring scan
  }
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = false; continue }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1))
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        } catch {
          return undefined
        }
        return undefined
      }
    }
  }
  return undefined
}

/** Parse a spawn directive from an agent's final summary (loose JSON). */
export function parseSpawnDirective(summary: string | undefined): SpawnDirective | undefined {
  if (summary === undefined || summary.trim() === '') return undefined
  const obj = extractJsonObject(summary)
  if (obj === undefined) return undefined
  if (obj.skip === true) return undefined
  if (typeof obj.title !== 'string' || typeof obj.prompt !== 'string') return undefined
  const workspaceId = typeof obj.workspace === 'string' && obj.workspace !== ''
    ? obj.workspace
    : typeof obj.workspaceId === 'string' && obj.workspaceId !== '' ? obj.workspaceId : undefined
  const input: NewTaskInput = {
    title: obj.title,
    description: typeof obj.description === 'string' ? obj.description : '',
    prompt: obj.prompt,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(typeof obj.mode === 'string' && obj.mode !== '' ? { mode: obj.mode } : {}),
  }
  return { input, ...(typeof obj.autoRun === 'boolean' ? { autoRun: obj.autoRun } : {}) }
}

export function createSpawnAction(): Action {
  return {
    id: SPAWN_ACTION_ID,
    when: ['succeeded'],
    run(ctx) {
      if (ctx.spawn === undefined) return
      const directive = parseSpawnDirective(ctx.execution.summary)
      if (directive === undefined) return
      ctx.spawn(directive.input, { autoRun: directive.autoRun === true })
    },
  }
}
