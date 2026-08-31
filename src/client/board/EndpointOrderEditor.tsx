/**
 * Endpoint order editor: the priority-ordered list of endpoints a task routes
 * through. The router uses the first eligible endpoint; later entries are
 * automatic fallbacks (e.g. a local endpoint for when the cloud one is out of
 * token space or outside its allowed hours). Empty list = the global default
 * endpoint list (and an empty effective list = direct model pin).
 */
import type { ExecutionEndpointOption } from '../../core/controller.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

export function EndpointOrderEditor({ endpoints, options, disabled = false, onChange }: {
  endpoints: readonly string[]
  options: readonly ExecutionEndpointOption[]
  disabled?: boolean
  onChange: (endpoints: string[]) => void
}) {
  if (options.length === 0) {
    return <p className={css.detailText}>{t('endpoint.none')}</p>
  }
  const byId = new Map(options.map(option => [option.id, option]))
  const remaining = options.filter(option => !endpoints.includes(option.id))
  const move = (index: number, delta: number): void => {
    const next = [...endpoints]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }
  return (
    <div className={css.endpointOrder}>
      <ol className={css.endpointOrderList}>
        {endpoints.map((id, index) => {
          const option = byId.get(id)
          return (
            <li key={id} className={css.endpointOrderRow}>
              <span className={css.endpointOrderName}>{option?.name ?? id}</span>
              <span className={css.endpointOrderActions}>
                <button
                  type="button"
                  className={css.ghostButton}
                  disabled={disabled || index === 0}
                  aria-label={t('endpoint.moveUp')}
                  onClick={() => { move(index, -1) }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={css.ghostButton}
                  disabled={disabled || index === endpoints.length - 1}
                  aria-label={t('endpoint.moveDown')}
                  onClick={() => { move(index, 1) }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={css.ghostButton}
                  disabled={disabled}
                  aria-label={t('endpoint.remove')}
                  onClick={() => { onChange(endpoints.filter(item => item !== id)) }}
                >
                  ×
                </button>
              </span>
            </li>
          )
        })}
      </ol>
      {remaining.length > 0 && (
        <select
          className={css.select}
          value=""
          disabled={disabled}
          aria-label={t('endpoint.add')}
          onChange={event => {
            if (event.target.value === '') return
            onChange([...endpoints, event.target.value])
          }}
        >
          <option value="">{t('endpoint.add')}…</option>
          {remaining.map(option => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}
