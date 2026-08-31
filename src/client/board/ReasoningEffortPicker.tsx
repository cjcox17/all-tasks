/**
 * Reasoning-effort picker for a pinned model: deployment default plus the
 * preset effort levels, passed through verbatim to the adapter. A value
 * outside the presets (already pinned on a task) stays selectable as a
 * custom row so the user can keep or clear it.
 */
import { REASONING_EFFORT_LEVELS, reasoningEffortLabelKey } from '../reasoning-effort.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

export function ReasoningEffortPicker({ value, disabled = false, onChange }: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const known = value === '' || (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
  return (
    <select
      className={css.select}
      value={value}
      disabled={disabled}
      aria-label={t('new.model.effort')}
      onChange={event => { onChange(event.target.value) }}
    >
      <option value="">{t('exec.model.default')}</option>
      {!known && <option value={value}>{value}{t('exec.model.effort.custom')}</option>}
      {REASONING_EFFORT_LEVELS.map(level => (
        <option key={level} value={level}>{t(reasoningEffortLabelKey(level))}</option>
      ))}
    </select>
  )
}
