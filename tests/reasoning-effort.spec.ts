import { describe, expect, it } from 'vitest'
import { REASONING_EFFORT_LEVELS, reasoningEffortLabelKey, withReasoningEffort } from '../src/client/reasoning-effort.ts'

describe('reasoning-effort helpers', () => {
  it('offers the common cross-provider effort presets', () => {
    expect(REASONING_EFFORT_LEVELS).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('maps a preset level to its locale key', () => {
    expect(reasoningEffortLabelKey('low')).toBe('exec.model.effort.low')
    expect(reasoningEffortLabelKey('high')).toBe('exec.model.effort.high')
  })

  it('attaches a trimmed effort to a model selection', () => {
    const model = { provider: 'deepseek', model: 'deepseek-chat' }
    expect(withReasoningEffort(model, '  high ')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
  })

  it('keeps the selection effort-free for a blank effort', () => {
    const model = { provider: 'deepseek', model: 'deepseek-chat' }
    expect(withReasoningEffort(model, '  ')).toEqual(model)
    expect(withReasoningEffort({ ...model, reasoningEffort: 'high' }, '')).toEqual(model)
  })
})
