import { describe, expect, it } from 'vitest'
import {
  clockMinutesInTimeZone,
  DEEPSEEK_OFF_PEAK,
  filterModelsByEndpoints,
  inDailyWindow,
  isOffPeakNow,
  normalizeEndpoint,
  normalizeEndpointsConfig,
  normalizeEndpointList,
  parseClock,
  pickEndpoint,
  resolveEndpointSelection,
  shouldUseRouter,
  weekdayInTimeZone,
  type EndpointConfig,
  type EndpointRouterConfig,
  type RouteDecision,
} from '../src/core/endpoints.ts'

function endpoint(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    provider: 'deepseek',
    models: [],
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

  it('handles windows that cross midnight', () => {
    const window = { start: '22:00', end: '06:00' }
    expect(inDailyWindow(23 * 60, window)).toBe(true) // 23:00
    expect(inDailyWindow(20, window)).toBe(true) // 00:20
    expect(inDailyWindow(12 * 60, window)).toBe(false) // 12:00
    expect(inDailyWindow(22 * 60, window)).toBe(true) // boundary start inclusive
    expect(inDailyWindow(6 * 60, window)).toBe(false) // boundary end exclusive
  })

  it('handles non-crossing windows', () => {
    const window = { start: '09:00', end: '17:00' }
    expect(inDailyWindow(540, window)).toBe(true)
    expect(inDailyWindow(1020, window)).toBe(false)
    expect(inDailyWindow(300, window)).toBe(false)
  })

  it('computes minutes-of-day and weekday in a named time zone', () => {
    const date = new Date(Date.UTC(2026, 6, 16, 2, 30)) // Thu 2026-07-16
    expect(clockMinutesInTimeZone(date, 'UTC')).toBe(150)
    expect(clockMinutesInTimeZone(date, 'Asia/Shanghai')).toBe(150 + 8 * 60) // UTC+8, same day
    expect(clockMinutesInTimeZone(new Date(Date.UTC(2026, 6, 16, 18, 30)), 'UTC')).toBe(1110)
    expect(clockMinutesInTimeZone(date, 'Not/AZone')).toBeUndefined()
    expect(weekdayInTimeZone(date, 'UTC')).toBe(4) // Thursday
    expect(weekdayInTimeZone(new Date(Date.UTC(2026, 6, 19)), 'UTC')).toBe(0) // Sunday
    expect(weekdayInTimeZone(date, 'Not/AZone')).toBeUndefined()
  })
})

describe('DeepSeek off-peak schedule (hard-coded since 2026-08-23)', () => {
  it('keeps the official peak windows (01:00–04:00 and 06:00–10:00 UTC Mon–Fri)', () => {
    expect(DEEPSEEK_OFF_PEAK).toEqual({
      peak: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'UTC',
    })
  })

  it('is off-peak inside the gaps and at weekends, peak inside the blocks', () => {
    // Mon 2026-07-13
    const monday = (hour: number) => new Date(Date.UTC(2026, 6, 13, hour))
    expect(isOffPeakNow(monday(0))).toBe(true) // 00:00
    expect(isOffPeakNow(monday(2))).toBe(false) // 02:00 peak block 1
    expect(isOffPeakNow(monday(5))).toBe(true) // 05:00 gap between blocks
    expect(isOffPeakNow(monday(8))).toBe(false) // 08:00 peak block 2
    expect(isOffPeakNow(monday(12))).toBe(true) // noon off-peak
    expect(isOffPeakNow(monday(23))).toBe(true)
    // Weekend: fully off-peak even inside the weekday peak blocks.
    const sunday = new Date(Date.UTC(2026, 6, 19, 2))
    expect(weekdayInTimeZone(sunday, 'UTC')).toBe(0)
    expect(isOffPeakNow(sunday)).toBe(true)
    const saturday = new Date(Date.UTC(2026, 6, 18, 8))
    expect(isOffPeakNow(saturday)).toBe(true)
  })

  it('treats an unusable time zone as off-peak (constraint skipped)', () => {
    const monday = new Date(Date.UTC(2026, 6, 13, 2))
    expect(isOffPeakNow(monday, { peak: [{ start: '01:00', end: '04:00' }], weekdays: [1], timezone: 'Not/AZone' })).toBe(true)
  })
})

describe('endpoint normalization', () => {
  it('normalizes a full endpoint entry with defaults', () => {
    expect(normalizeEndpoint({
      id: ' local ', name: 'LM Studio', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'],
      defaultModel: 'qwen/qwen3.8-27b',
    })).toEqual({
      id: 'local',
      name: 'LM Studio',
      provider: 'lm-studio',
      models: ['qwen/qwen3.8-27b'],
      defaultModel: 'qwen/qwen3.8-27b',
    })
  })

  it('drops unusable entries and ignores provider-ish extras', () => {
    expect(normalizeEndpoint({ name: 'no id', provider: 'x' })).toBeUndefined()
    expect(normalizeEndpoint({ id: 'e', provider: '' })).toBeUndefined()
    const minimal = normalizeEndpoint({ id: 'e', provider: 'p' })!
    expect(minimal.name).toBe('e')
    expect(minimal.models).toEqual([])
    expect(minimal.defaultModel).toBeUndefined()
    // Provider-level fields are not endpoint concerns; they are ignored.
    expect(normalizeEndpoint({ id: 'e', provider: 'p', maxConcurrency: 0, allowedHours: { start: 'nope', end: 'x' } }))
      .toEqual({ id: 'e', name: 'e', provider: 'p', models: [] })
    expect(normalizeEndpoint({ id: 'e', provider: 'p', models: ['m1', 'm1', 'm2'] })?.models).toEqual(['m1', 'm2'])
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

  it('builds a safe router config', () => {
    const config = normalizeEndpointsConfig({ endpoints: [{ id: 'a', provider: 'p' }, { id: 'a', provider: 'dup' }] })
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

function config(endpoints: readonly EndpointConfig[], overrides: Partial<EndpointRouterConfig> = {}): EndpointRouterConfig {
  return { endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [...endpoints], ...overrides }
}

describe('pickEndpoint routing', () => {
  it('returns unrouted when no endpoints are configured anywhere', () => {
    expect(pickEndpoint({}, config([]))).toEqual({ mode: 'unrouted' })
    expect(pickEndpoint({ endpoints: [] }, config([]))).toEqual({ mode: 'unrouted' })
    expect(shouldUseRouter({ endpoints: ['a'] }, config([]))).toBe(true)
    expect(shouldUseRouter({}, config([]))).toBe(false)
  })

  it('routes through the first endpoint that can serve the task in priority order', () => {
    const endpoints = [
      // No default model: the local endpoint cannot serve a deepseek pin.
      endpoint({ id: 'local', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'] }),
      endpoint({ id: 'cloud', provider: 'deepseek', models: [], defaultModel: 'deepseek-chat' }),
    ]
    // The pinned model is deepseek-chat: the local endpoint cannot serve it, so the cloud one wins.
    const decision = pickEndpoint({ endpoints: ['local', 'cloud'], model: { provider: 'deepseek', model: 'deepseek-chat' } }, config(endpoints))
    expect(decision).toMatchObject({ mode: 'routed', endpoint: { id: 'cloud' }, selection: { provider: 'deepseek', model: 'deepseek-chat' } })
    // The local endpoint serves the pinned qwen model directly.
    const local = pickEndpoint({ endpoints: ['local', 'cloud'], model: { provider: 'lm-studio', model: 'qwen/qwen3.8-27b' } }, config(endpoints))
    expect(local).toMatchObject({ mode: 'routed', endpoint: { id: 'local' } })
  })

  it('waits (preferred = first known candidate) when every candidate cannot serve the task', () => {
    const endpoints = [
      endpoint({ id: 'local', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'] }),
      endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'] }),
    ]
    const decision: RouteDecision = pickEndpoint({ endpoints: ['local', 'missing', 'cloud'], model: { provider: 'deepseek', model: 'deepseek-chat' } }, config(endpoints))
    expect(decision.mode).toBe('wait')
    if (decision.mode === 'wait') {
      expect(decision.endpointId).toBe('local')
      expect(decision.reasons).toContain('unknown-endpoint')
      expect(decision.reasons).toContain('model-not-served')
    }
  })

  it('uses the global default list for tasks without explicit pins', () => {
    const endpoints = [endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' })]
    const routerConfig = config(endpoints, { defaultEndpoints: ['cloud'] })
    const decision = pickEndpoint({}, routerConfig)
    expect(decision).toMatchObject({ mode: 'routed', endpoint: { id: 'cloud' } })
  })

  it('skips unknown endpoint ids entirely and runs unrouted when none resolve', () => {
    const decision = pickEndpoint({ endpoints: ['ghost'] }, config([endpoint()]))
    expect(decision).toMatchObject({ mode: 'unrouted' })
  })

  it('prefers a pinned model over the endpoint default when both are served', () => {
    const endpoints = [endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-reasoner' })]
    const decision = pickEndpoint({ endpoints: ['cloud'], model: { provider: 'deepseek', model: 'deepseek-chat' } }, config(endpoints))
    expect(decision).toMatchObject({ mode: 'routed', selection: { provider: 'deepseek', model: 'deepseek-chat' } })
  })
})

describe('model-servability filter (picker-side)', () => {
  const CATALOG = [
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'deepseek', model: 'deepseek-reasoner' },
    { provider: 'lm-studio', model: 'qwen/qwen3.8-27b' },
  ] as const

  it('returns the catalog unchanged when no endpoints are pinned', () => {
    expect(filterModelsByEndpoints(CATALOG, [], [])).toEqual(CATALOG)
  })

  it('returns the catalog unchanged when every pinned id is unknown', () => {
    expect(filterModelsByEndpoints(CATALOG, [endpoint({ id: 'cloud', provider: 'deepseek' })], ['ghost'])).toEqual(CATALOG)
  })

  it('returns the catalog unchanged when the pinned row has no provider (router drops it)', () => {
    expect(filterModelsByEndpoints(CATALOG, [{ id: 'partial' }], ['partial'])).toEqual(CATALOG)
  })

  it('keeps every model of the provider when the endpoint serves all of them', () => {
    const filtered = filterModelsByEndpoints(CATALOG, [endpoint({ id: 'cloud', provider: 'deepseek' })], ['cloud'])
    expect(filtered.map(model => model.model)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('keeps only the endpoint\'s narrowed models', () => {
    const filtered = filterModelsByEndpoints(
      CATALOG,
      [endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-chat'] })],
      ['cloud'],
    )
    expect(filtered.map(model => model.model)).toEqual(['deepseek-chat'])
  })

  it('keeps the endpoint default model even when it is outside the narrowed list', () => {
    const filtered = filterModelsByEndpoints(
      CATALOG,
      [endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-chat'], defaultModel: 'deepseek-reasoner' })],
      ['cloud'],
    )
    expect(filtered.map(model => model.model).sort()).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('unions models across several pinned endpoints', () => {
    const filtered = filterModelsByEndpoints(
      CATALOG,
      [
        endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-chat'] }),
        endpoint({ id: 'local', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'] }),
      ],
      ['cloud', 'local'],
    )
    expect(filtered.map(model => model.model).sort()).toEqual(['deepseek-chat', 'qwen/qwen3.8-27b'])
  })

  it('drops the whole provider when the pinned endpoint cannot serve it', () => {
    const filtered = filterModelsByEndpoints(
      CATALOG,
      [endpoint({ id: 'local', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'] })],
      ['local'],
    )
    expect(filtered.map(model => model.provider)).toEqual(['lm-studio'])
  })
})
