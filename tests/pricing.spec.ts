/**
 * Cost estimation engine: the official DeepSeek peak/off-peak rate table and
 * the per-execution cost resolution (endpoint routing, model fallback, cache
 * split, local endpoint pricing, unrouted pins).
 */
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_RATES,
  executionCostUsd,
  type PricingEndpoint,
  type PricingExecution,
} from '../src/core/pricing.ts'

// Mon 2026-07-13 UTC: 02:00 is inside the peak window, 05:00/12:00 are off-peak.
const PEAK = Date.UTC(2026, 6, 13, 2)
const OFF_PEAK = Date.UTC(2026, 6, 13, 12)
const SATURDAY = Date.UTC(2026, 6, 18, 8)

const OFFICIAL: PricingEndpoint = {
  id: 'ds',
  provider: DEEPSEEK_OFFICIAL_PROVIDER,
  models: [],
  defaultModel: 'deepseek-v4-flash',
}

function exec(overrides: Partial<PricingExecution> & { startedAt?: number } = {}): PricingExecution {
  return {
    startedAt: OFF_PEAK,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  }
}

describe('DEEPSEEK_OFFICIAL_RATES', () => {
  it('covers every official model id of the current catalog', () => {
    expect(Object.keys(DEEPSEEK_OFFICIAL_RATES).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ])
  })

  it('mirrors the official rule that off-peak rates are half of peak rates', () => {
    for (const rate of Object.values(DEEPSEEK_OFFICIAL_RATES)) {
      expect(rate.inputCacheHit.offPeak).toBeCloseTo(rate.inputCacheHit.peak / 2)
      expect(rate.inputCacheMiss.offPeak).toBeCloseTo(rate.inputCacheMiss.peak / 2)
      expect(rate.output.offPeak).toBeCloseTo(rate.output.peak / 2)
    }
  })

  it('keeps the published numbers for deepseek-v4-flash', () => {
    const flash = DEEPSEEK_OFFICIAL_RATES['deepseek-v4-flash']!
    expect(flash.inputCacheHit).toEqual({ peak: 0.014, offPeak: 0.007 })
    expect(flash.inputCacheMiss).toEqual({ peak: 0.44, offPeak: 0.22 })
    expect(flash.output).toEqual({ peak: 1.32, offPeak: 0.66 })
  })
})

describe('executionCostUsd', () => {
  it('returns undefined without usage', () => {
    expect(executionCostUsd(exec({ usage: undefined }), {}, [OFFICIAL])).toBeUndefined()
  })

  it('bills official runs at the peak rate inside a peak window and half price off-peak', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const peak = executionCostUsd(exec({ endpointId: 'ds', launchedAt: PEAK, usage }), {}, [OFFICIAL])
    expect(peak).toBeCloseTo(0.44 + 1.32)
    const offPeak = executionCostUsd(exec({ endpointId: 'ds', launchedAt: OFF_PEAK, usage }), {}, [OFFICIAL])
    expect(offPeak).toBeCloseTo(0.22 + 0.66)
    // Weekends are fully off-peak even inside the weekday peak windows.
    const weekend = executionCostUsd(exec({ endpointId: 'ds', launchedAt: SATURDAY, usage }), {}, [OFFICIAL])
    expect(weekend).toBeCloseTo(0.22 + 0.66)
  })

  it('splits cache-hit input at the cache-hit rate and cache writes at the miss rate', () => {
    const cost = executionCostUsd(exec({
      endpointId: 'ds',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    }), {}, [OFFICIAL])
    expect(cost).toBeCloseTo(0.007 + 0.22)
  })

  it('uses the pinned model when the endpoint serves it, else the endpoint default model', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    const pinned = { provider: DEEPSEEK_OFFICIAL_PROVIDER, model: 'deepseek-v4-pro' }
    // The pin is served (empty model list) and wins over the default.
    const viaPin = executionCostUsd(exec({ endpointId: 'ds', usage }), { model: pinned }, [OFFICIAL])
    expect(viaPin).toBeCloseTo(0.66) // deepseek-v4-pro off-peak miss
    // The pin is not served by the narrowed list, so the default model applies.
    const narrowed: PricingEndpoint = { ...OFFICIAL, models: ['deepseek-v4-flash-vision-exp'] }
    const viaDefault = executionCostUsd(exec({ endpointId: 'ds', usage }), { model: pinned }, [narrowed])
    expect(viaDefault).toBeCloseTo(0.22) // deepseek-v4-flash off-peak miss
  })

  it('falls back to startedAt when launchedAt is absent', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    expect(executionCostUsd(exec({ endpointId: 'ds', launchedAt: undefined, startedAt: PEAK, usage }), {}, [OFFICIAL]))
      .toBeCloseTo(0.44)
    expect(executionCostUsd(exec({ endpointId: 'ds', launchedAt: undefined, startedAt: OFF_PEAK, usage }), {}, [OFFICIAL]))
      .toBeCloseTo(0.22)
  })

  it('returns undefined for an official model without a published rate', () => {
    const unknown = { ...OFFICIAL, defaultModel: 'deepseek-legacy' }
    expect(executionCostUsd(exec({ endpointId: 'ds' }), {}, [unknown])).toBeUndefined()
  })

  it('bills local endpoints at their own flat rates', () => {
    const local: PricingEndpoint = { id: 'lm', provider: 'lm-studio', costPerMillionInputTokens: 1, costPerMillionOutputTokens: 2 }
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000 }
    // Local pricing counts all input at the input rate (cache included):
    // 1.25M in @ 1 + 0.5M out @ 2 = 1.25 + 1.
    expect(executionCostUsd(exec({ endpointId: 'lm', usage }), {}, [local])).toBeCloseTo(1.25 + 1)
  })

  it('returns undefined for a local endpoint without pricing and for unknown endpoints', () => {
    const unpriced: PricingEndpoint = { id: 'lm', provider: 'lm-studio' }
    expect(executionCostUsd(exec({ endpointId: 'lm' }), {}, [unpriced])).toBeUndefined()
    expect(executionCostUsd(exec({ endpointId: 'ghost' }), {}, [OFFICIAL, unpriced])).toBeUndefined()
  })

  it('prices unrouted DeepSeek pins via official rates and leaves unrouted local pins unpriced', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const dsPin = { provider: DEEPSEEK_OFFICIAL_PROVIDER, model: 'deepseek-v4-flash' }
    expect(executionCostUsd(exec({ endpointId: undefined, usage }), { model: dsPin }, [OFFICIAL])).toBeCloseTo(0.22 + 0.66)
    const localPin = { provider: 'lm-studio', model: 'qwen/qwen3.8-27b' }
    expect(executionCostUsd(exec({ endpointId: undefined, usage }), { model: localPin }, [OFFICIAL])).toBeUndefined()
    expect(executionCostUsd(exec({ endpointId: undefined, usage }), {}, [OFFICIAL])).toBeUndefined()
  })
})
