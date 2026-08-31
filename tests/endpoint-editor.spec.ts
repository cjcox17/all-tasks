import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFF_PEAK,
  endpointEditorOps,
  parseEndpointEditorPatch,
  readEndpointEditorState,
  type EndpointEditorView,
} from '../src/endpoint-editor.ts'

const FULL_VIEW: EndpointEditorView = {
  id: 'lm-studio-nas',
  name: 'LM Studio (NAS)',
  provider: 'lm-studio',
  models: ['qwen/qwen3.8-27b'],
  defaultModel: 'qwen/qwen3.8-27b',
  maxConcurrency: 2,
  maxTokens: 8192,
  allowedHours: { start: '09:00', end: '23:00' },
  offPeakOnly: true,
  offPeak: { start: '18:00', end: '06:00', timezone: 'Asia/Shanghai' },
}

describe('readEndpointEditorState', () => {
  it('resolves the endpoint list with schema-defaulted fields', () => {
    const state = readEndpointEditorState({
      endpoints: [
        { id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio' },
        { id: 'deepseek', provider: 'deepseek', maxConcurrency: 2 },
      ],
      defaultEndpoints: ['deepseek', 'lm-studio-nas'],
    })
    expect(state.endpoints).toHaveLength(2)
    expect(state.endpoints[0]).toEqual({
      id: 'lm-studio-nas',
      name: 'LM Studio (NAS)',
      provider: 'lm-studio',
      models: [],
      defaultModel: '',
      maxConcurrency: 1,
      maxTokens: 0,
      allowedHours: { start: '', end: '' },
      offPeakOnly: false,
      offPeak: { ...DEFAULT_OFF_PEAK },
    })
    expect(state.endpoints[1]?.maxConcurrency).toBe(2)
    expect(state.defaultEndpoints).toEqual(['deepseek', 'lm-studio-nas'])
  })

  it('drops malformed entries and unknown default-list ids', () => {
    const state = readEndpointEditorState({
      endpoints: [{ id: 'ok', provider: 'lm-studio' }, { provider: 'no-id' }, 'junk'],
      defaultEndpoints: ['ok', 'missing', 'ok'],
    })
    expect(state.endpoints.map(endpoint => endpoint.id)).toEqual(['ok'])
    expect(state.defaultEndpoints).toEqual(['ok'])
  })

  it('returns an empty state for an absent or malformed namespace', () => {
    expect(readEndpointEditorState(undefined)).toEqual({ endpoints: [], defaultEndpoints: [] })
    expect(readEndpointEditorState({ endpoints: 'nope' })).toEqual({ endpoints: [], defaultEndpoints: [] })
    expect(readEndpointEditorState(null)).toEqual({ endpoints: [], defaultEndpoints: [] })
  })
})

describe('parseEndpointEditorPatch', () => {
  it('parses a full endpoint and normalizes lists', () => {
    const state = parseEndpointEditorPatch({
      endpoints: [
        {
          id: ' lm-studio-nas ',
          name: 'LM Studio (NAS)',
          provider: ' lm-studio ',
          models: ['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b', ' qwen/qwen3-coder-30b '],
          defaultModel: 'qwen/qwen3.8-27b',
          maxConcurrency: 2,
          maxTokens: 8192,
          allowedHours: { start: '09:00', end: '23:00' },
          offPeakOnly: true,
          offPeak: { start: '18:00', end: '06:00', timezone: 'Asia/Shanghai' },
        },
      ],
      defaultEndpoints: ['lm-studio-nas'],
    })
    expect(state.endpoints).toEqual([{ ...FULL_VIEW, models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'] }])
    expect(state.defaultEndpoints).toEqual(['lm-studio-nas'])
  })

  it('applies defaults for omitted fields', () => {
    const state = parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }] })
    expect(state.endpoints[0]).toMatchObject({
      name: '',
      models: [],
      defaultModel: '',
      maxConcurrency: 1,
      maxTokens: 0,
      allowedHours: { start: '', end: '' },
      offPeakOnly: false,
      offPeak: { ...DEFAULT_OFF_PEAK },
    })
    expect(state.defaultEndpoints).toEqual([])
  })

  it('rejects malformed patches with field-naming messages', () => {
    expect(() => parseEndpointEditorPatch(null)).toThrow(/must be an object/)
    expect(() => parseEndpointEditorPatch({})).toThrow(/endpoints must be an array/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ provider: 'p' }] })).toThrow(/id is required/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a' }] })).toThrow(/provider is required/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }, { id: 'a', provider: 'q' }] })).toThrow(/duplicates endpoint/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', maxConcurrency: 0 }] })).toThrow(/maxConcurrency/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', maxTokens: -1 }] })).toThrow(/maxTokens/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', models: 'x' }] })).toThrow(/models must be an array/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', allowedHours: { start: '09:00' } }] })).toThrow(/allowedHours/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', allowedHours: { start: '25:00', end: '23:00' } }] })).toThrow(/HH:MM/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', offPeakOnly: 'yes' }] })).toThrow(/offPeakOnly/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }], defaultEndpoints: ['nope'] })).toThrow(/unknown endpoint/)
    expect(parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }], defaultEndpoints: ['a', 'a'] })).toEqual({
      endpoints: [expect.objectContaining({ id: 'a' })],
      defaultEndpoints: ['a'],
    })
  })
})

describe('endpointEditorOps', () => {
  it('emits one set op for endpoints and one for the default order', () => {
    const state = parseEndpointEditorPatch({ endpoints: [FULL_VIEW], defaultEndpoints: ['lm-studio-nas'] })
    const ops = endpointEditorOps(state)
    expect(ops).toHaveLength(2)
    expect(ops[0]).toMatchObject({ op: 'set', path: ['endpoints'] })
    expect(ops[1]).toEqual({ op: 'set', path: ['defaultEndpoints'], value: ['lm-studio-nas'] })
    const stored = (ops[0] as { value: unknown }).value as unknown[]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual({
      id: 'lm-studio-nas',
      name: 'LM Studio (NAS)',
      provider: 'lm-studio',
      models: ['qwen/qwen3.8-27b'],
      defaultModel: 'qwen/qwen3.8-27b',
      maxConcurrency: 2,
      maxTokens: 8192,
      allowedHours: { start: '09:00', end: '23:00' },
      offPeakOnly: true,
      offPeak: { start: '18:00', end: '06:00', timezone: 'Asia/Shanghai' },
    })
  })

  it('omits fields equal to their defaults so the section stays hand-editable', () => {
    const state = parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }] })
    const stored = (endpointEditorOps(state)[0] as { value: unknown }).value as unknown[]
    expect(stored[0]).toEqual({ id: 'a', provider: 'p' })
  })

  it('round-trips a full state through read -> ops -> read stably', () => {
    const state = parseEndpointEditorPatch({ endpoints: [FULL_VIEW, { id: 'minimal', provider: 'deepseek' }], defaultEndpoints: ['minimal', 'lm-studio-nas'] })
    const ops = endpointEditorOps(state)
    const value = (ops[0] as { value: unknown }).value
    const reread = readEndpointEditorState({ endpoints: value, defaultEndpoints: (ops[1] as { value: unknown }).value })
    expect(reread).toEqual(state)
  })
})
