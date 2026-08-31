import { describe, expect, it } from 'vitest'
import {
  endpointEditorOps,
  endpointTimeoutPatches,
  parseEndpointEditorPatch,
  readEndpointEditorState,
  readEndpointProviderCatalog,
  type EndpointEditorView,
  type EndpointProviderInfo,
} from '../src/endpoint-editor.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEEPSEEK_PROVIDER } from '../src/model-timeouts.ts'

const FULL_VIEW: EndpointEditorView = {
  id: 'lm-studio-nas',
  name: 'LM Studio (NAS)',
  provider: 'lm-studio',
  models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'],
  defaultModel: 'qwen/qwen3.8-27b',
  idleSeconds: 900,
  totalSeconds: 3600,
}

const PROVIDERS: readonly EndpointProviderInfo[] = [
  {
    provider: 'lm-studio',
    displayName: 'LM Studio',
    namespace: 'llm-pi-ai',
    models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'],
    streamIdleTimeoutMs: 900_000,
    timeoutMs: 3_600_000,
  },
  {
    provider: DEEPSEEK_PROVIDER,
    displayName: 'DeepSeek',
    namespace: 'llm-deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  },
]

describe('readEndpointEditorState', () => {
  it('resolves the endpoint list with schema-defaulted fields', () => {
    const state = readEndpointEditorState({
      endpoints: [
        { id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio' },
        { id: 'deepseek', provider: DEEPSEEK_PROVIDER },
      ],
      defaultEndpoints: ['deepseek', 'lm-studio-nas'],
    }, PROVIDERS)
    expect(state.endpoints).toHaveLength(2)
    expect(state.endpoints[0]).toEqual({
      id: 'lm-studio-nas',
      name: 'LM Studio (NAS)',
      provider: 'lm-studio',
      models: [],
      defaultModel: '',
      idleSeconds: 900,
      totalSeconds: 3600,
    })
    expect(state.endpoints[1]).toMatchObject({ provider: DEEPSEEK_PROVIDER, idleSeconds: 300, totalSeconds: 0 })
    expect(state.defaultEndpoints).toEqual(['deepseek', 'lm-studio-nas'])
  })

  it('defaults timeouts to the DSH default when no provider view matches', () => {
    const state = readEndpointEditorState({ endpoints: [{ id: 'ghost', provider: 'nope' }] }, PROVIDERS)
    expect(state.endpoints[0]).toMatchObject({ idleSeconds: 300, totalSeconds: 0 })
  })

  it('drops malformed entries and unknown default-list ids', () => {
    const state = readEndpointEditorState({
      endpoints: [{ id: 'ok', provider: 'lm-studio' }, { provider: 'no-id' }, 'junk'],
      defaultEndpoints: ['ok', 'missing', 'ok'],
    }, PROVIDERS)
    expect(state.endpoints.map(endpoint => endpoint.id)).toEqual(['ok'])
    expect(state.defaultEndpoints).toEqual(['ok'])
  })

  it('returns an empty state for an absent or malformed namespace', () => {
    expect(readEndpointEditorState(undefined)).toEqual({ endpoints: [], defaultEndpoints: [] })
    expect(readEndpointEditorState({ endpoints: 'nope' })).toEqual({ endpoints: [], defaultEndpoints: [] })
    expect(readEndpointEditorState(null)).toEqual({ endpoints: [], defaultEndpoints: [] })
  })
})

describe('readEndpointProviderCatalog', () => {
  it('resolves pi-ai routes and the official DeepSeek route with models and timeouts', () => {
    const catalog = readEndpointProviderCatalog(
      {
        providers: {
          'lm-studio': {
            displayName: 'LM Studio',
            models: [{ id: 'qwen/qwen3.8-27b' }, { id: 'qwen/qwen3-coder-30b' }],
            streamIdleTimeoutMs: 900_000,
            timeoutMs: 3_600_000,
          },
        },
      },
      { models: ['deepseek-chat', 'deepseek-reasoner'], streamIdleTimeoutMs: 600_000 },
    )
    expect(catalog).toEqual([
      {
        provider: 'lm-studio',
        displayName: 'LM Studio',
        namespace: 'llm-pi-ai',
        models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'],
        streamIdleTimeoutMs: 900_000,
        timeoutMs: 3_600_000,
      },
      {
        provider: DEEPSEEK_PROVIDER,
        displayName: 'DeepSeek',
        namespace: 'llm-deepseek',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        streamIdleTimeoutMs: 600_000,
      },
    ])
  })

  it('accepts plain-string model lists and absent sections', () => {
    expect(readEndpointProviderCatalog({ providers: { p: { models: ['a', 'b'] } } }, undefined)).toHaveLength(1)
    expect(readEndpointProviderCatalog(undefined, undefined)).toEqual([])
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
          idleSeconds: 900,
          totalSeconds: 3600,
        },
      ],
      defaultEndpoints: ['lm-studio-nas'],
    })
    expect(state.endpoints).toEqual([{ ...FULL_VIEW }])
    expect(state.defaultEndpoints).toEqual(['lm-studio-nas'])
  })

  it('applies defaults for omitted fields', () => {
    const state = parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }] })
    expect(state.endpoints[0]).toMatchObject({
      name: '',
      models: [],
      defaultModel: '',
      idleSeconds: 300,
      totalSeconds: 0,
    })
    expect(state.defaultEndpoints).toEqual([])
  })

  it('rejects malformed patches with field-naming messages', () => {
    expect(() => parseEndpointEditorPatch(null)).toThrow(/must be an object/)
    expect(() => parseEndpointEditorPatch({})).toThrow(/endpoints must be an array/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ provider: 'p' }] })).toThrow(/id is required/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a' }] })).toThrow(/provider is required/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }, { id: 'a', provider: 'q' }] })).toThrow(/duplicates endpoint/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', models: 'x' }] })).toThrow(/models must be an array/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', idleSeconds: 0 }] })).toThrow(/idleSeconds/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', idleSeconds: 86_401 }] })).toThrow(/idleSeconds/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', idleSeconds: 1.5 }] })).toThrow(/idleSeconds/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p', totalSeconds: -1 }] })).toThrow(/totalSeconds/)
    expect(() => parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }], defaultEndpoints: ['nope'] })).toThrow(/unknown endpoint/)
    expect(parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }], defaultEndpoints: ['a', 'a'] })).toEqual({
      endpoints: [expect.objectContaining({ id: 'a' })],
      defaultEndpoints: ['a'],
    })
  })
})

describe('endpointEditorOps', () => {
  it('emits one set op for endpoints and one for the default order (timeouts not stored here)', () => {
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
      models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'],
      defaultModel: 'qwen/qwen3.8-27b',
    })
  })

  it('omits fields equal to their defaults so the section stays hand-editable', () => {
    const state = parseEndpointEditorPatch({ endpoints: [{ id: 'a', provider: 'p' }] })
    const stored = (endpointEditorOps(state)[0] as { value: unknown }).value as unknown[]
    expect(stored[0]).toEqual({ id: 'a', provider: 'p' })
  })
})

describe('endpointTimeoutPatches', () => {
  it('writes the endpoint timeouts through to its provider route', () => {
    const state = parseEndpointEditorPatch({ endpoints: [FULL_VIEW], defaultEndpoints: [] })
    const patches = endpointTimeoutPatches(state, PROVIDERS)
    expect(patches).toEqual([
      {
        namespace: 'llm-pi-ai',
        provider: 'lm-studio',
        streamIdleTimeoutMs: 900_000,
        timeoutMs: 3_600_000,
      },
    ])
  })

  it('omits the total timeout for the official DeepSeek route (no total supported)', () => {
    const state = parseEndpointEditorPatch({
      endpoints: [{ id: 'ds', provider: DEEPSEEK_PROVIDER, idleSeconds: 600, totalSeconds: 0 }],
    })
    const patches = endpointTimeoutPatches(state, PROVIDERS)
    expect(patches).toEqual([
      { namespace: 'llm-deepseek', provider: DEEPSEEK_PROVIDER, streamIdleTimeoutMs: 600_000 },
    ])
  })

  it('skips endpoints on unknown providers', () => {
    const state = parseEndpointEditorPatch({ endpoints: [{ id: 'ghost', provider: 'nope', idleSeconds: 600 }] })
    expect(endpointTimeoutPatches(state, PROVIDERS)).toEqual([])
  })
})
