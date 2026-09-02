/**
 * Board dashboard: the summary strip above the workspace directory. Renders
 * the pure {@link computeDashboard} metrics as compact stat cards — tasks,
 * running/queued, completed/failed with success rate, scheduled/groups, token
 * totals, and an estimated cost. Token and cost cards show "—" until the
 * adapter reports usage (and pricing is configured, for cost). When a usage
 * retention window is active, `usageWindowLabel` (e.g. "last 24 h") prefixes
 * the token and cost card subtitles so the narrowed totals read clearly.
 */
import type { DashboardMetrics } from '../../core/dashboard.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

const countFormat = new Intl.NumberFormat()
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function Card({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className={css.dashCard} data-tone={tone}>
      <span className={css.dashLabel}>{label}</span>
      <span className={css.dashValue}>{value}</span>
      <span className={css.dashSub}>{sub}</span>
    </div>
  )
}

export function Dashboard({ metrics, usageWindowLabel }: { metrics: DashboardMetrics; usageWindowLabel?: string }) {
  const rate = metrics.successRate === undefined ? '—' : String(Math.round(metrics.successRate * 100))
  const tokens = metrics.tokens.available
    ? `${compactFormat.format(metrics.tokens.input)} / ${compactFormat.format(metrics.tokens.output)}`
    : '—'
  const cost = metrics.cost === undefined ? '—' : `$${metrics.cost.toFixed(2)}`
  const windowed = (sub: string): string => usageWindowLabel === undefined ? sub : `${usageWindowLabel} · ${sub}`
  return (
    <div className={css.dashboard} data-dsh-part="dashboard">
      <Card
        label={t('dash.tasks')}
        value={countFormat.format(metrics.total)}
        sub={t('dash.todoSub', { todo: String(metrics.todo), pending: String(metrics.pending) })}
        tone="neutral"
      />
      <Card
        label={t('dash.running')}
        value={countFormat.format(metrics.running)}
        sub={t('dash.queueSub', { queued: String(metrics.queued) })}
        tone="running"
      />
      <Card
        label={t('dash.completed')}
        value={countFormat.format(metrics.completed)}
        sub={t('dash.successSub', { rate })}
        tone="success"
      />
      <Card
        label={t('dash.failed')}
        value={countFormat.format(metrics.failed)}
        sub={t('dash.runsSub', { count: String(metrics.runs) })}
        tone="failed"
      />
      <Card
        label={t('dash.scheduled')}
        value={countFormat.format(metrics.scheduled)}
        sub={t('dash.groupsSub', { active: String(metrics.activeGroups), total: String(metrics.groups) })}
        tone="scheduled"
      />
      <Card
        label={t('dash.tokens')}
        value={tokens}
        sub={windowed(t('dash.tokensSub', { reasoning: compactFormat.format(metrics.tokens.reasoning) }))}
        tone="tokens"
      />
      <Card
        label={t('dash.cost')}
        value={cost}
        sub={windowed(t('dash.costSub'))}
        tone="cost"
      />
    </div>
  )
}
