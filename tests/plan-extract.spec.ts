/**
 * Plan-phase capture and hand-off: extraction from session history events
 * (the exit_plan_mode tool call wins over the final assistant message), the
 * stuck-review detection, and the plan/work prompt builders.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlanPrompt,
  buildWorkPrompt,
  extractPlan,
  planAwaitingReview,
  PLAN_LIMIT,
} from '../src/core/plan-extract.ts'

/** One history entry shaped like the runner's scan input. */
function event(seq: number, type: string, data: unknown, time = seq * 1000): { event: { type: string; seq: number; time: number; data: unknown } } {
  return { event: { type, seq, time, data } }
}

function toolCall(seq: number, name: string, args: string, time?: number) {
  return event(seq, 'tool/call', { name, arguments: args }, time)
}

function toolResult(seq: number, time?: number) {
  return event(seq, 'tool/result', { message: { role: 'tool' as const, content: [{ type: 'text', text: 'ok' }] } }, time)
}

function assistant(seq: number, text: string, time?: number) {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant' as const, content: [{ type: 'text', text }] },
  }, time)
}

describe('extractPlan', () => {
  it('prefers the exit_plan_mode tool-call plan over the final assistant message', () => {
    const events = [
      assistant(1, 'Let me think about this…'),
      toolCall(2, 'exit_plan_mode', JSON.stringify({ plan: '# Plan\nDo the thing.' })),
      toolResult(3),
      assistant(4, 'Plan approved.'),
    ]
    expect(extractPlan(events)).toBe('# Plan\nDo the thing.')
  })

  it('falls back to the newest assistant message when the model never called exit_plan_mode', () => {
    const events = [assistant(1, 'first'), assistant(2, '# Plan\nFinal plan.')]
    expect(extractPlan(events)).toBe('# Plan\nFinal plan.')
  })

  it('ignores other tool calls and malformed exit_plan_mode arguments', () => {
    const events = [
      toolCall(1, 'read', JSON.stringify({ path: '/tmp/x' })),
      toolCall(2, 'exit_plan_mode', '{not json'),
      assistant(3, '# Plan\nFallback.'),
    ]
    expect(extractPlan(events)).toBe('# Plan\nFallback.')
  })

  it('drops events before the plan boundary (a shared session paging into an earlier turn)', () => {
    const events = [assistant(1, '# Old plan'), assistant(2, '# New plan')]
    expect(extractPlan(events, 1500)).toBe('# New plan')
  })

  it('bounds an oversized plan to PLAN_LIMIT with an ellipsis', () => {
    const huge = 'x'.repeat(PLAN_LIMIT + 100)
    const plan = extractPlan([assistant(1, huge)])
    expect(plan?.length).toBe(PLAN_LIMIT + 1)
    expect(plan?.endsWith('…')).toBe(true)
  })

  it('returns undefined when the turn produced no plan text at all', () => {
    expect(extractPlan([toolResult(1)])).toBeUndefined()
  })
})

describe('planAwaitingReview', () => {
  it('detects an exit_plan_mode call whose result never landed', () => {
    const events = [toolCall(2, 'exit_plan_mode', JSON.stringify({ plan: '# Plan' }))]
    expect(planAwaitingReview(events)).toBe(true)
  })

  it('is false once the review was answered', () => {
    const events = [toolCall(2, 'exit_plan_mode', JSON.stringify({ plan: '# Plan' })), toolResult(3)]
    expect(planAwaitingReview(events)).toBe(false)
  })

  it('is false when only unrelated tool calls are pending', () => {
    const events = [toolCall(2, 'read', JSON.stringify({ path: '/tmp/x' }))]
    expect(planAwaitingReview(events)).toBe(false)
  })

  it('ignores calls before the boundary', () => {
    const events = [toolCall(2, 'exit_plan_mode', JSON.stringify({ plan: '# Plan' }))]
    expect(planAwaitingReview(events, 2500)).toBe(false)
  })
})

describe('plan prompt builders', () => {
  it('builds a plan prompt that keeps the plan turn self-contained', () => {
    const prompt = buildPlanPrompt({ prompt: 'fix the bug', title: 'Fix' })
    expect(prompt).toContain('fix the bug')
    expect(prompt).toContain('exit_plan_mode')
    expect(prompt).toContain('plan mode')
  })

  it('builds a plan prompt from the title when the prompt is blank', () => {
    expect(buildPlanPrompt({ prompt: '', title: 'Fix' })).toContain('Fix')
  })

  it('hands the approved plan and the original task to the worker', () => {
    const prompt = buildWorkPrompt('# Plan\nStep 1', { prompt: 'fix the bug', title: 'Fix' })
    expect(prompt).toContain('# Plan\nStep 1')
    expect(prompt).toContain('fix the bug')
    expect(prompt).toContain('do not re-plan')
  })
})
