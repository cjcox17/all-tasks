import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  fallbackTitle,
  sanitizeGeneratedTitle,
  titleInstruction,
  TITLE_MAX_LENGTH,
} from '../src/core/title.ts'
import { HostExecutionRunner } from '../src/host-runner.ts'
import {
  parseTitleSuggestionRequest,
  suggestTaskTitle,
  TITLE_GENERATOR_SESSION_TITLE,
  TITLE_INPUT_BOUND,
} from '../src/title-suggest.ts'

function ok<T>(request: { rpcId: unknown }, value: T) {
  return { rpcId: request.rpcId, result: { ok: true as const, value } }
}

function assistantEvent(seq: number, time: number, text: string) {
  return { event: { type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } } }
}

function turnEndEvent(seq: number, time: number, kind: string) {
  return { event: { type: 'turn/end', seq, time, data: { reason: { kind } } } }
}

/** A fake API proxy whose generator session settles with the given events. */
function generatorApi(events: Array<{ event: { type: string; seq?: number; time?: number; data?: unknown } }> = []) {
  const calls = {
    create: vi.fn(async (request) => ok(request, { sessionId: 'session-gen' })),
    rename: vi.fn(async (request) => ok(request, { title: 'x', seq: 1 })),
    selectModel: vi.fn(async (request) => ok(request, { selected: { provider: 'deepseek', model: 'deepseek-chat' } })),
    prompt: vi.fn(async (request) => ok(request, { accepted: true })),
    list: vi.fn(async (request) => ok(request, { items: [{ sessionId: 'session-gen', running: false }] })),
    history: vi.fn(async (request) => ok(request, { events, hasMore: false })),
    cancel: vi.fn(async (request) => ok(request, { accepted: true })),
  }
  const api = {
    sessions: {
      create: calls.create,
      rename: calls.rename,
      selectModel: calls.selectModel,
      prompt: calls.prompt,
      list: calls.list,
      history: calls.history,
      cancel: calls.cancel,
    },
  }
  return { api: api as unknown as ApiProxy, calls }
}

describe('fallbackTitle', () => {
  it('takes the prompt’s first meaningful line', () => {
    expect(fallbackTitle('  Fix the login bug\n\nDetails follow', '')).toBe('Fix the login bug')
  })

  it('strips leading list/heading markers', () => {
    expect(fallbackTitle('- refactor the scheduler', '')).toBe('refactor the scheduler')
    expect(fallbackTitle('## Release notes draft', '')).toBe('Release notes draft')
    expect(fallbackTitle('> quote a doc', '')).toBe('quote a doc')
  })

  it('falls back to the description when the prompt is blank', () => {
    expect(fallbackTitle('', 'Review the PR before merge')).toBe('Review the PR before merge')
  })

  it('skips blank leading lines', () => {
    expect(fallbackTitle('\n\nReal work here', '')).toBe('Real work here')
  })

  it('returns the empty string when nothing is usable', () => {
    expect(fallbackTitle('', '')).toBe('')
    expect(fallbackTitle('   \n\t', '')).toBe('')
  })

  it('truncates long titles to the cap with an ellipsis', () => {
    const title = fallbackTitle('a'.repeat(TITLE_MAX_LENGTH + 50), '')
    expect(title).toBe('a'.repeat(TITLE_MAX_LENGTH - 1) + '…')
    expect(title.length).toBe(TITLE_MAX_LENGTH)
  })
})

describe('sanitizeGeneratedTitle', () => {
  it('keeps a plain single line', () => {
    expect(sanitizeGeneratedTitle('Fix the login bug')).toBe('Fix the login bug')
  })

  it('strips surrounding quotes, bullets, and fenced code', () => {
    expect(sanitizeGeneratedTitle('"Fix the login bug"')).toBe('Fix the login bug')
    expect(sanitizeGeneratedTitle('- Fix the login bug')).toBe('Fix the login bug')
    expect(sanitizeGeneratedTitle('```\nFix the login bug\n```')).toBe('Fix the login bug')
  })

  it('keeps only the first line of a wrapped answer', () => {
    expect(sanitizeGeneratedTitle('Fix the login bug\n\nA longer explanation the model added.')).toBe('Fix the login bug')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeGeneratedTitle('Fix   the  login   bug')).toBe('Fix the login bug')
  })

  it('returns undefined for blank or unusable answers', () => {
    expect(sanitizeGeneratedTitle('')).toBeUndefined()
    expect(sanitizeGeneratedTitle('   ')).toBeUndefined()
    expect(sanitizeGeneratedTitle('```\n```')).toBeUndefined()
    expect(sanitizeGeneratedTitle('"   "')).toBeUndefined()
  })

  it('truncates long titles to the cap', () => {
    const title = sanitizeGeneratedTitle('a'.repeat(TITLE_MAX_LENGTH + 20))
    expect(title).toBe('a'.repeat(TITLE_MAX_LENGTH - 1) + '…')
  })
})

describe('titleInstruction', () => {
  it('embeds the run prompt', () => {
    const instruction = titleInstruction('Fix the login bug', '')
    expect(instruction).toContain('Fix the login bug')
    expect(instruction).toContain('at most 80 characters')
  })

  it('adds the description as context when present', () => {
    const instruction = titleInstruction('Fix the login bug', 'Users are locked out')
    expect(instruction).toContain('Task description:')
    expect(instruction).toContain('Users are locked out')
  })
})

describe('parseTitleSuggestionRequest', () => {
  it('accepts a prompt alone', () => {
    expect(parseTitleSuggestionRequest({ prompt: 'do the thing' })).toEqual({ prompt: 'do the thing' })
  })

  it('accepts a description as the title source and an optional model pin', () => {
    expect(parseTitleSuggestionRequest({ prompt: '', description: 'do the thing' })).toEqual({ prompt: '', description: 'do the thing' })
    expect(parseTitleSuggestionRequest({
      prompt: 'do it',
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    })).toEqual({
      prompt: 'do it',
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    })
  })

  it('rejects a fully blank request, unknown keys, oversized text, and malformed models', () => {
    expect(parseTitleSuggestionRequest({ prompt: '', description: '' })).toBeUndefined()
    expect(parseTitleSuggestionRequest({})).toBeUndefined()
    expect(parseTitleSuggestionRequest({ prompt: 'x', surprise: 1 })).toBeUndefined()
    expect(parseTitleSuggestionRequest({ prompt: 'a'.repeat(TITLE_INPUT_BOUND + 1) })).toBeUndefined()
    expect(parseTitleSuggestionRequest({ prompt: 'x', model: { provider: 'deepseek' } })).toBeUndefined()
    expect(parseTitleSuggestionRequest({ prompt: 'x', model: { provider: 'deepseek', model: '' } })).toBeUndefined()
    expect(parseTitleSuggestionRequest({ prompt: 'x', model: 'deepseek-chat' })).toBeUndefined()
  })
})

describe('suggestTaskTitle', () => {
  it('generates a title through a backend session and sanitizes the answer', async () => {
    const { api, calls } = generatorApi([
      turnEndEvent(20, 2_000, 'complete'),
      assistantEvent(15, 1_500, '"Fix the login bug"'),
    ])
    const runner = new HostExecutionRunner(api)
    const title = await suggestTaskTitle(runner, api, { prompt: 'Fix the login bug', description: 'Users locked out' })

    expect(title).toBe('Fix the login bug')
    // The generator session is named identifiably and prompted with the
    // strict instruction, then cancelled (a settled idle session no-ops).
    expect(calls.rename.mock.calls[0][0].payload.title).toBe(TITLE_GENERATOR_SESSION_TITLE)
    expect(calls.prompt.mock.calls[0][0].payload.content[0].text).toContain('Fix the login bug')
    expect(calls.prompt.mock.calls[0][0].payload.content[0].text).toContain('Users locked out')
    expect(calls.cancel).toHaveBeenCalledOnce()
  })

  it('applies the requested model pin to the generator session', async () => {
    const { api, calls } = generatorApi([
      turnEndEvent(20, 2_000, 'complete'),
      assistantEvent(15, 1_500, 'Plan the migration'),
    ])
    const runner = new HostExecutionRunner(api)
    const title = await suggestTaskTitle(runner, api, {
      prompt: 'Plan the migration',
      model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    })

    expect(title).toBe('Plan the migration')
    expect(calls.selectModel).toHaveBeenCalledOnce()
    expect(calls.selectModel.mock.calls[0][0].payload).toMatchObject({
      sessionId: 'session-gen',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    })
  })

  it('returns undefined when the turn failed', async () => {
    const { api } = generatorApi([turnEndEvent(20, 2_000, 'error')])
    const runner = new HostExecutionRunner(api)
    await expect(suggestTaskTitle(runner, api, { prompt: 'do it' })).resolves.toBeUndefined()
  })

  it('returns undefined when the answer carries no usable title', async () => {
    const { api } = generatorApi([
      turnEndEvent(20, 2_000, 'complete'),
      assistantEvent(15, 1_500, '```\n```'),
    ])
    const runner = new HostExecutionRunner(api)
    await expect(suggestTaskTitle(runner, api, { prompt: 'do it' })).resolves.toBeUndefined()
  })

  it('gives up and cancels the session when the turn exceeds the deadline', async () => {
    const { api, calls } = generatorApi()
    // The session stays running: inspect never settles, and a zero deadline
    // expires on the first probe without any real wait.
    calls.list.mockImplementation(async (request: { rpcId: unknown }) =>
      ok(request, { items: [{ sessionId: 'session-gen', running: true }] }))
    const runner = new HostExecutionRunner(api)
    await expect(suggestTaskTitle(runner, api, { prompt: 'do it' }, () => 0, 0)).resolves.toBeUndefined()
    expect(calls.cancel).toHaveBeenCalledOnce()
  })
})
