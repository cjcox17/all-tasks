/**
 * Usage charts: cost-over-time and tokens-over-time graphs for the landing
 * dashboard, rendered between the summary cards and the workspace list. One
 * granularity dropdown (hourly / daily / weekly) drives both panels; the
 * series come from the pure {@link computeUsageSeries} (bucketed by run start
 * time in the browser's local time zone, fixed recent windows).
 *
 * Bars are plain HTML/CSS columns — no chart dependency — with native `title`
 * tooltips and `data-dsh-part` / `data-start` / `data-value` attributes for
 * skins and tests. The current-hour/day/week bucket rolls with a 60 s clock
 * while the landing view stays open, so a long-idle page does not freeze the
 * window at mount time.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CostPricingInput } from '../../core/dashboard.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { computeUsageSeries, type UsageGranularity } from '../../core/usage-series.ts'
import { t, type AllTasksKey } from '../locales.ts'
import css from '../board.module.css'

const GRANULARITIES: readonly UsageGranularity[] = ['hourly', 'daily', 'weekly']

const GRANULARITY_KEYS: Record<UsageGranularity, AllTasksKey> = {
  hourly: 'usage.option.hourly',
  daily: 'usage.option.daily',
  weekly: 'usage.option.weekly',
}

const WINDOW_KEYS: Record<UsageGranularity, AllTasksKey> = {
  hourly: 'usage.window.hourly',
  daily: 'usage.window.daily',
  weekly: 'usage.window.weekly',
}

const numberFormat = new Intl.NumberFormat()
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Cost formatting: two decimals at a human scale, four for sub-cent buckets. */
export function formatCost(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

/** One stacked segment of a usage column. */
interface BarSegment {
  value: number
  /** CSS class providing the segment's fill color. */
  className: string
}

/** A bucket as the bar plot sees it. */
interface UsageBarPoint {
  start: number
  label: string
  /** Full tooltip for the column. */
  title: string
  segments: readonly BarSegment[]
}

/**
 * A compact stacked-column plot: one column per bucket, heights relative to
 * the tallest stacked total, a top gridline with the scale value, and a
 * subsampled x-axis label row.
 */
function UsageBars({ points, max, maxLabel }: { points: readonly UsageBarPoint[]; max: number; maxLabel: string }) {
  return (
    <div className={css.usageBars}>
      <div className={css.usageScale} aria-hidden="true">
        <span className={css.usageScaleValue}>{maxLabel}</span>
      </div>
      <div className={css.usagePlot}>
        {points.map((point, index) => {
          const total = point.segments.reduce((sum, segment) => sum + segment.value, 0)
          const step = Math.ceil(points.length / 8)
          return (
            <div
              key={point.start}
              className={css.usageCol}
              data-dsh-part="usage-bar"
              data-start={String(point.start)}
              data-value={String(total)}
              title={point.title}
              aria-label={point.title}
            >
              <div className={css.usageTrack}>
                {total > 0 && (
                  <div className={css.usageStack}>
                    {point.segments.map((segment, index) => (
                      <div
                        key={index}
                        className={segment.className}
                        style={{ height: `${Math.max(0, (segment.value / max) * 100)}%` }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <span className={css.usageLabel} aria-hidden="true">
                {index % step === 0 || index === points.length - 1 ? point.label : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One chart panel: title, window hint, and either the bars or an empty note. */
function UsagePanel({ chart, title, hint, children }: {
  chart: 'cost' | 'tokens'
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <section className={css.usagePanel} data-dsh-part="usage-chart" data-chart={chart}>
      <h4 className={css.usagePanelTitle}>{title}</h4>
      <p className={css.usagePanelHint}>{hint}</p>
      {children}
    </section>
  )
}

/**
 * The dashboard usage section. `tasks` and `pricing` come from the controller
 * snapshot; granularity is local view state (one dropdown drives both charts).
 */
export function UsageCharts({ tasks, pricing }: { tasks: readonly TaskRecord[]; pricing?: CostPricingInput }) {
  const [granularity, setGranularity] = useState<UsageGranularity>('daily')
  // Roll the window end so the "current" bucket stays current while the
  // landing view is open, even when no snapshot revision arrives.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { window.clearInterval(timer) }
  }, [])

  const series = useMemo(
    () => computeUsageSeries(tasks, { granularity, now, pricing }),
    [tasks, granularity, now, pricing],
  )

  const anyUsage = series.some(point => point.available)
  const maxTokens = series.reduce((max, point) => Math.max(max, point.input + point.output + point.reasoning), 0)
  const maxCost = series.reduce((max, point) => Math.max(max, point.cost ?? 0), 0)
  const pricingMissing = anyUsage && pricing === undefined
  const windowHint = t(WINDOW_KEYS[granularity])

  const tokenBars: UsageBarPoint[] = series.map(point => ({
    start: point.start,
    label: point.label,
    title: `${point.label} — ${t('usage.tooltipTokens', {
      input: numberFormat.format(point.input),
      output: numberFormat.format(point.output),
      reasoning: numberFormat.format(point.reasoning),
    })}`,
    segments: [
      { value: point.input, className: css.usageInput },
      { value: point.output, className: css.usageOutput },
      ...(point.reasoning > 0 ? [{ value: point.reasoning, className: css.usageReasoning }] : []),
    ],
  }))

  const costBars: UsageBarPoint[] = series.map(point => ({
    start: point.start,
    label: point.label,
    title: `${point.label} — ${point.cost === undefined ? '—' : formatCost(point.cost)}`,
    segments: point.cost === undefined
      ? []
      : [{ value: point.cost, className: css.usageCost }],
  }))

  return (
    <section className={css.usageSection} data-dsh-part="usage">
      <header className={css.usageHeader}>
        <h3 className={css.usageTitle}>{t('usage.title')}</h3>
        <label className={css.usageSelectWrap}>
          <span className={css.usageSelectLabel}>{t('usage.granularity')}</span>
          <select
            className={css.usageSelect}
            data-dsh-part="usage-granularity"
            value={granularity}
            onChange={event => { setGranularity(event.target.value as UsageGranularity) }}
          >
            {GRANULARITIES.map(option => (
              <option key={option} value={option}>{t(GRANULARITY_KEYS[option])}</option>
            ))}
          </select>
        </label>
      </header>
      <div className={css.usageGrid}>
        <UsagePanel chart="cost" title={t('usage.cost')} hint={windowHint}>
          {costBars.some(point => point.segments.length > 0)
            ? <UsageBars points={costBars} max={maxCost} maxLabel={formatCost(maxCost)} />
            : <p className={css.usageEmpty}>{pricingMissing ? t('usage.emptyCost') : t('usage.empty')}</p>}
        </UsagePanel>
        <UsagePanel chart="tokens" title={t('usage.tokens')} hint={windowHint}>
          {anyUsage
            ? <>
              <UsageBars points={tokenBars} max={maxTokens} maxLabel={compactFormat.format(maxTokens)} />
              <div className={css.usageLegend} aria-hidden="true">
                <span className={css.usageLegendItem}><i className={css.usageInput} />{t('usage.input')}</span>
                <span className={css.usageLegendItem}><i className={css.usageOutput} />{t('usage.output')}</span>
                <span className={css.usageLegendItem}><i className={css.usageReasoning} />{t('usage.reasoning')}</span>
              </div>
            </>
            : <p className={css.usageEmpty}>{t('usage.empty')}</p>}
        </UsagePanel>
      </div>
    </section>
  )
}
