import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  assertTimeoutMs,
  modelTimeoutOps,
  readModelTimeoutViews,
  type ModelTimeoutView,
} from '../src/model-timeouts.ts'

function piAi(providers: Record<string, unknown>): unknown {
  return { providers }
}

const LM_STUDIO_VIEW: ModelTimeoutView = {
  provider: 'lm-studio',
  displayName: 'LM Studio',
  namespace: 'llm-pi-ai',
  streamIdleTimeoutMs: 600_000,
  timeoutMs: 900_000,
}

describe('readModelTimeoutViews', () => {
  it('resolves pi-ai provider rows with displayName and explicit timeouts', () => {
    const views = readModelTimeoutViews(
      piAi({ 'lm-studio': { displayName: 'LM Studio', streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } }),
      undefined,
    )
    expect(views).toEqual([LM_STUDIO_VIEW])
  })

  it('defaults the idle timeout and omits an unset total timeout', () => {
    const views = readModelTimeoutViews(piAi({ ollama: { baseURL: 'http://127.0.0.1:11434/v1' } }), undefined)
    expect(views).toEqual([{
      provider: 'ollama',
      displayName: 'ollama',
      namespace: 'llm-pi-ai',
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    }])
  })

  it('adds the deepseek-official row when the llm-deepseek namespace resolves', () => {
    const views = readModelTimeoutViews(undefined, { streamIdleTimeoutMs: 600_000 })
    expect(views).toEqual([{
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      namespace: 'llm-deepseek',
      streamIdleTimeoutMs: 600_000,
    }])
  })

  it('omits the deepseek row when the namespace is absent', () => {
    expect(readModelTimeoutViews(piAi({ x: {} }), undefined).some(view => view.namespace === 'llm-deepseek')).toBe(false)
  })

  it('returns an empty list for absent or malformed sections', () => {
    expect(readModelTimeoutViews(undefined, undefined)).toEqual([])
    expect(readModelTimeoutViews({ providers: 'nope' }, undefined)).toEqual([])
    expect(readModelTimeoutViews({ providers: { bad: 'string' } }, undefined)).toEqual([])
    expect(readModelTimeoutViews(null, null)).toEqual([])
  })

  it('treats an empty deepseek section as registered with the default timeout', () => {
    expect(readModelTimeoutViews(undefined, {})).toEqual([{
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      namespace: 'llm-deepseek',
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    }])
  })
})

describe('modelTimeoutOps', () => {
  it('emits set ops for a pi-ai provider with idle and total timeouts', () => {
    const { namespace, ops } = modelTimeoutOps(LM_STUDIO_VIEW, {
      provider: 'lm-studio',
      streamIdleTimeoutMs: 900_000,
      timeoutMs: 1_200_000,
    })
    expect(namespace).toBe('llm-pi-ai')
    expect(ops).toEqual([
      { op: 'set', path: ['providers', 'lm-studio', 'streamIdleTimeoutMs'], value: 900_000 },
      { op: 'set', path: ['providers', 'lm-studio', 'timeoutMs'], value: 1_200_000 },
    ])
  })

  it('unsets both fields on null, restoring the schema defaults', () => {
    const { ops } = modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: null, timeoutMs: null })
    expect(ops).toEqual([
      { op: 'unset', path: ['providers', 'lm-studio', 'streamIdleTimeoutMs'] },
      { op: 'unset', path: ['providers', 'lm-studio', 'timeoutMs'] },
    ])
  })

  it('leaves the stored total timeout untouched when absent from the patch', () => {
    const { ops } = modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: 600_000 })
    expect(ops).toEqual([{ op: 'set', path: ['providers', 'lm-studio', 'streamIdleTimeoutMs'], value: 600_000 }])
  })

  it('writes the deepseek section root and refuses a total timeout there', () => {
    const { namespace, ops } = modelTimeoutOps(
      { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', streamIdleTimeoutMs: 300_000 },
      { provider: 'deepseek-official', streamIdleTimeoutMs: 600_000 },
    )
    expect(namespace).toBe('llm-deepseek')
    expect(ops).toEqual([{ op: 'set', path: ['streamIdleTimeoutMs'], value: 600_000 }])
    expect(() => modelTimeoutOps(
      { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', streamIdleTimeoutMs: 300_000 },
      { provider: 'deepseek-official', streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 },
    )).toThrow(/only supported for llm-pi-ai/)
    const unset = modelTimeoutOps(
      { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', streamIdleTimeoutMs: 300_000 },
      { provider: 'deepseek-official', streamIdleTimeoutMs: null },
    )
    expect(unset.ops).toEqual([{ op: 'unset', path: ['streamIdleTimeoutMs'] }])
  })

  it('rejects non-finite, zero, and over-cap timeouts', () => {
    expect(() => modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: 0 })).toThrow(/between 1 and/)
    expect(() => modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(/between 1 and/)
    expect(() => modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/between 1 and/)
    expect(() => modelTimeoutOps(LM_STUDIO_VIEW, { provider: 'lm-studio', streamIdleTimeoutMs: 600_000, timeoutMs: -5 })).toThrow(/between 1 and/)
    expect(() => assertTimeoutMs(Number.NaN, 'x')).toThrow(/between 1 and/)
  })
})
