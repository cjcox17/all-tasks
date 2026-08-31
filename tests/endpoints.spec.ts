import { describe, expect, it } from 'vitest'
import {
  clockMinutesInTimeZone,
  DEEPSEEK_OFF_PEAK,
  effectiveOffPeakWindow,
  inDailyWindow,
  isEndpointEligible,
  normalizeEndpoint,
  normalizeEndpointsConfig,
  normalizeEndpointList,
  normalizeOffPeakWindow,
  parseClock,
  pickEndpoint,
  resolveEndpointSelection,
  shouldUseRouter,
  type EndpointConfig,
  type EndpointEligibilityInput,
  type EndpointRouterConfig,
  type RouteDecision,
} from '../src/core/endpoints.ts'

function endpoint(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    provider: 'deepseek',
    models: [],
    maxConcurrency: 1,
    offPeakOnly: false,
    ...overrides,
  }
}

function eligibility(overrides: Partial<EndpointEligibilityInput> = {}): EndpointEligibilityInput {
  return {
    endpoint: endpoint(),
    localMinutes: 600,
    offPeakMinutes: 1080,
    offPeakWindow: { start: '16:30', end: '00:30', timezone: 'UTC' },
    activeCount: 0,
    modelMaxTokens: undefined,
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
    ...overrides,
  }
}

describe('clock parsing and daily windows', () => {
  it('parses 24h HH:MM into minutes since midnight', () => {
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('16:30')).toBe(990)
    expect(parseClock('23:59')).toBe(1439)
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('9:5')).toBeUndefined()
    expect(parseClock('ab:cd')).toBeUndefined()
  })

  it('handles windows that cross midnight (off-peak 16:30–00:30)', () => {
    const window = { start: '16:30', end: '00:30' }
    expect(inDailyWindow(1080, window)).toBe(true) // 18:00
    expect(inDailyWindow(20, window)).toBe(true) // 00:20
    expect(inDailyWindow(720, window)).toBe(false) // 12:00
    expect(inDailyWindow(990, window)).toBe(true) // boundary start inclusive
    expect(inDailyWindow(30, window)).toBe(false) // boundary end exclusive
  })

  it('handles non-crossing windows', () => {
    const window = { start: '09:00', end: '17:00' }
    expect(inDailyWindow(540, window)).toBe(true)
    expect(inDailyWindow(1020, window)).toBe(false)
    expect(inDailyWindow(300, window)).toBe(false)
  })

  it('computes minutes-of-day in a named time zone', () => {
    const date = new Date(Date.UTC(2026, 6, 16, 2, 30))
    expect(clockMinutesInTimeZone(date, 'UTC')).toBe(150)
    expect(clockMinutesInTimeZone(date, 'Asia/Shanghai')).toBe(150 + 8 * 60) // UTC+8, same day
    expect(clockMinutesInTimeZone(new Date(Date.UTC(2026, 6, 16, 18, 30)), 'UTC')).toBe(1110)
    expect(clockMinutesInTimeZone(date, 'Not/AZone')).toBeUndefined()
  })

  it('falls back to the DeepSeek default for a malformed off-peak window', () => {
    expect(normalizeOffPeakWindow({})).toEqual(DEEPSEEK_OFF_PEAK)
    expect(normalizeOffPeakWindow('nope')).toEqual(DEEPSEEK_OFF_PEAK)
    expect(normalizeOffPeakWindow({ start: '10:00', end: '14:00', timezone: 'Asia/Shanghai' }))
      .toEqual({ start: '10:00', end: '14:00', timezone: 'Asia/Shanghai' })
  })
})

describe('endpoint normalization', () => {
  it('normalizes a full endpoint entry with defaults', () => {
    expect(normalizeEndpoint({
      id: ' local ', name: 'LM Studio', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'],
      maxConcurrency: 3, maxTokens: 8192, allowedHours: { start: '09:00', end: '17:00' },
      offPeakOnly: true, offPeak: { start: '00:00', end: '06:00', timezone: 'UTC' },
    })).toEqual({
      id: 'local',
      name: 'LM Studio',
      provider: 'lm-studio',
      models: ['qwen/qwen3.8-27b'],
      maxConcurrency: 3,
      maxTokens: 8192,
      allowedHours: { start: '09:00', end: '17:00' },
      offPeakOnly: true,
      offPeak: { start: '00:00', end: '06:00', timezone: 'UTC' },
    })
  })

  it('drops unusable entries and clamps values', () => {
    expect(normalizeEndpoint({ name: 'no id', provider: 'x' })).toBeUndefined()
    expect(normalizeEndpoint({ id: 'e', provider: '' })).toBeUndefined()
    const minimal = normalizeEndpoint({ id: 'e', provider: 'p' })!
    expect(minimal.name).toBe('e')
    expect(minimal.maxConcurrency).toBe(1)
    expect(minimal.maxTokens).toBeUndefined()
    expect(minimal.models).toEqual([])
    expect(minimal.offPeakOnly).toBe(false)
    expect(normalizeEndpoint({ id: 'e', provider: 'p', maxConcurrency: 0 })?.maxConcurrency).toBe(1) // clamps to the default
    expect(normalizeEndpoint({ id: 'e', provider: 'p', maxConcurrency: 1.5 })?.maxConcurrency).toBe(1)
    expect(normalizeEndpoint({ id: 'e', provider: 'p', models: ['m1', 'm1', 'm2'] })?.models).toEqual(['m1', 'm2'])
    expect(normalizeEndpoint({ id: 'e', provider: 'p', allowedHours: { start: 'nope', end: 'x' } })?.allowedHours).toBeUndefined()
  })

  it('normalizes endpoint id lists (dedupe, bounds, blank collapse)', () => {
    expect(normalizeEndpointList(['a', ' b ', 'a'])).toEqual(['a', 'b'])
    expect(normalizeEndpointList([])).toBeUndefined()
    expect(normalizeEndpointList(undefined)).toBeUndefined()
    expect(normalizeEndpointList(['', '  '])).toBeUndefined()
    expect(normalizeEndpointList('not-array')).toBeUndefined()
    expect(normalizeEndpointList(['a', 5 as never])).toEqual(['a'])
    expect(normalizeEndpointList(Array.from({ length: 40 }, (_, i) => `e${i}`))).toHaveLength(16)
  })

  it('builds a safe router config with the DeepSeek default window', () => {
    const config = normalizeEndpointsConfig({ endpoints: [{ id: 'a', provider: 'p' }, { id: 'a', provider: 'dup' }] })
    expect(config.offPeak).toEqual(DEEPSEEK_OFF_PEAK)
    expect(config.endpointMaxWaitHours).toBe(24)
    expect(config.defaultEndpoints).toEqual([])
    expect(config.endpoints).toHaveLength(1) // dedup by id, first wins
    expect(config.endpoints[0]?.provider).toBe('p')
  })
})

describe('selection resolution', () => {
  it('uses the pinned model when the endpoint serves it, else the default model', () => {
    const all = endpoint({ provider: 'deepseek', models: [] })
    expect(resolveEndpointSelection({ model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } }, all))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    const filtered = endpoint({ provider: 'deepseek', models: ['deepseek-reasoner'], defaultModel: 'deepseek-reasoner' })
    expect(resolveEndpointSelection({ model: { provider: 'deepseek', model: 'deepseek-chat' } }, filtered))
      .toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    const noDefault = endpoint({ provider: 'deepseek', models: ['deepseek-reasoner'] })
    expect(resolveEndpointSelection({ model: { provider: 'deepseek', model: 'deepseek-chat' } }, noDefault)).toBeUndefined()
    const foreignProvider = endpoint({ provider: 'lm-studio', defaultModel: 'qwen/qwen3.8-27b' })
    expect(resolveEndpointSelection({ model: { provider: 'deepseek', model: 'deepseek-chat' } }, foreignProvider))
      .toEqual({ provider: 'lm-studio', model: 'qwen/qwen3.8-27b' })
  })
})

describe('endpoint eligibility', () => {
  it('is eligible when nothing blocks', () => {
    expect(isEndpointEligible(eligibility())).toEqual({ ok: true })
  })

  it('blocks outside allowed hours', () => {
    const input = eligibility({ endpoint: endpoint({ allowedHours: { start: '12:00', end: '14:00' } }), localMinutes: 600 })
    expect(isEndpointEligible(input)).toEqual({ ok: false, reason: 'outside-allowed-hours' })
    expect(isEndpointEligible(eligibility({ endpoint: endpoint({ allowedHours: { start: '09:00', end: '11:00' } }), localMinutes: 600 }))).toEqual({ ok: true })
  })

  it('blocks when off-peak-only outside the window (midnight crossing respected)', () => {
    const offPeak = { start: '16:30', end: '00:30', timezone: 'UTC' }
    const input = eligibility({ endpoint: endpoint({ offPeakOnly: true }), offPeakWindow: offPeak })
    expect(isEndpointEligible({ ...input, offPeakMinutes: 1080 })).toEqual({ ok: true }) // 18:00 UTC
    expect(isEndpointEligible({ ...input, offPeakMinutes: 720 })).toEqual({ ok: false, reason: 'off-peak-only' }) // 12:00 UTC
  })

  it('blocks when concurrency is full', () => {
    expect(isEndpointEligible(eligibility({ endpoint: endpoint({ maxConcurrency: 2 }), activeCount: 2 })))
      .toEqual({ ok: false, reason: 'concurrency-full' })
    expect(isEndpointEligible(eligibility({ endpoint: endpoint({ maxConcurrency: 2 }), activeCount: 1 }))).toEqual({ ok: true })
  })

  it('blocks when the model exceeds the endpoint token cap', () => {
    const input = eligibility({ endpoint: endpoint({ maxTokens: 4096 }), modelMaxTokens: 8192 })
    expect(isEndpointEligible(input)).toEqual({ ok: false, reason: 'model-over-cap' })
    expect(isEndpointEligible(eligibility({ endpoint: endpoint({ maxTokens: 4096 }), modelMaxTokens: 4096 }))).toEqual({ ok: true })
    expect(isEndpointEligible(eligibility({ endpoint: endpoint({ maxTokens: 4096 }) }))).toEqual({ ok: true }) // unknown model cap
  })

  it('blocks when the endpoint cannot serve the task', () => {
    expect(isEndpointEligible(eligibility({ selection: undefined }))).toEqual({ ok: false, reason: 'model-not-served' })
  })
})

function config(endpoints: readonly EndpointConfig[]): EndpointRouterConfig {
  return { offPeak: { ...DEEPSEEK_OFF_PEAK }, endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [...endpoints] }
}

describe('pickEndpoint routing', () => {
  const state = {
    localMinutes: 600,
    offPeakMinutes: 720,
    activeCounts: new Map<string, number>(),
    modelMaxTokens: () => undefined,
  }

  it('returns unrouted when no endpoints are configured anywhere', () => {
    expect(pickEndpoint({}, config([]), state)).toEqual({ mode: 'unrouted' })
    expect(pickEndpoint({ endpoints: [] }, config([]), state)).toEqual({ mode: 'unrouted' })
    expect(shouldUseRouter({ endpoints: ['a'] }, config([]))).toBe(true)
    expect(shouldUseRouter({}, config([]))).toBe(false)
  })

  it('routes through the first eligible endpoint in priority order', () => {
    const endpoints = [
      endpoint({ id: 'local', provider: 'lm-studio', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'qwen/qwen3.8-27b' }),
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ]
    const decision = pickEndpoint({ endpoints: ['local', 'cloud'] }, config(endpoints), state)
    expect(decision).toMatchObject({ mode: 'routed', endpoint: { id: 'cloud' }, selection: { provider: 'deepseek', model: 'deepseek-chat' } })
  })

  it('waits (preferred = first known candidate) when every candidate is blocked', () => {
    const endpoints = [
      endpoint({ id: 'local', provider: 'lm-studio', offPeakOnly: true, defaultModel: 'qwen/qwen3.8-27b' }),
      endpoint({ id: 'cloud', provider: 'deepseek', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'deepseek-chat' }),
    ]
    const decision: RouteDecision = pickEndpoint({ endpoints: ['local', 'missing', 'cloud'] }, config(endpoints), state)
    expect(decision.mode).toBe('wait')
    if (decision.mode === 'wait') {
      expect(decision.endpointId).toBe('local')
      expect(decision.reasons).toContain('unknown-endpoint')
      expect(decision.reasons).toContain('off-peak-only')
    }
  })

  it('uses the global default list for tasks without explicit pins', () => {
    const endpoints = [endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' })]
    const routerConfig = { ...config(endpoints), defaultEndpoints: ['cloud'] }
    const decision = pickEndpoint({}, routerConfig, state)
    expect(decision).toMatchObject({ mode: 'routed', endpoint: { id: 'cloud' } })
  })

  it('skips unknown endpoint ids entirely and runs unrouted when none resolve', () => {
    const decision = pickEndpoint({ endpoints: ['ghost'] }, config([endpoint()]), state)
    expect(decision).toMatchObject({ mode: 'unrouted' })
  })

  it('respects the endpoint token cap through the model-maxTokens reader', () => {
    const endpoints = [
      endpoint({ id: 'small', provider: 'deepseek', maxTokens: 1024, defaultModel: 'deepseek-chat' }),
      endpoint({ id: 'big', provider: 'deepseek', maxTokens: 65536, defaultModel: 'deepseek-chat' }),
    ]
    const capped = { ...state, modelMaxTokens: () => 8192 }
    const decision = pickEndpoint({ endpoints: ['small', 'big'] }, config(endpoints), capped)
    expect(decision).toMatchObject({ mode: 'routed', endpoint: { id: 'big' } })
  })

  it('counts active launches per endpoint for concurrency', () => {
    const endpoints = [endpoint({ id: 'a', provider: 'p', maxConcurrency: 1, defaultModel: 'm' })]
    const full = { ...state, activeCounts: new Map([['a', 1]]) }
    const decision = pickEndpoint({ endpoints: ['a'] }, config(endpoints), full)
    expect(decision.mode).toBe('wait')
    const free = { ...state, activeCounts: new Map([['a', 0]]) }
    expect(pickEndpoint({ endpoints: ['a'] }, config(endpoints), free)).toMatchObject({ mode: 'routed' })
  })

  it('resolves the per-endpoint off-peak override for eligibility', () => {
    const endpoints = [endpoint({
      id: 'night', provider: 'p', offPeakOnly: true, defaultModel: 'm',
      offPeak: { start: '00:00', end: '06:00', timezone: 'UTC' },
    })]
    // 12:00 UTC is inside the global window but outside this endpoint's override.
    const decision = pickEndpoint({ endpoints: ['night'] }, config(endpoints), state)
    expect(decision.mode).toBe('wait')
    const night = { ...state, offPeakMinutes: 120 } // 02:00 UTC
    expect(pickEndpoint({ endpoints: ['night'] }, config(endpoints), night)).toMatchObject({ mode: 'routed' })
    expect(effectiveOffPeakWindow(endpoints[0]!, { ...DEEPSEEK_OFF_PEAK })).toEqual({ start: '00:00', end: '06:00', timezone: 'UTC' })
  })
})
