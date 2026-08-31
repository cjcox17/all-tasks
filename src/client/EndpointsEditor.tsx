/**
 * Endpoints editor for the task-board settings card.
 *
 * Endpoints are the compute targets the endpoint model-router routes tasks
 * through (DeepSeek Official, an LM Studio on the NAS, …). They live in the
 * plugin's own `task-board` settings namespace; before this editor the only
 * way to configure them was editing `~/.dsh/settings.yaml` by hand, so the
 * task modal's Endpoints dropdown stayed empty. This section reads the
 * current endpoints through the board's own HTTP routes and writes a full
 * replacement immediately (one Save for the whole list), so the modal
 * dropdown and the router pick the change up live — no restart.
 */

import { useEffect, useState } from 'react'
import type { EndpointEditorView } from '../endpoint-editor.ts'
import type { TaskBoardKey } from './locales.ts'
import css from './endpoints-editor.module.css'

/** Bound on endpoint id/name/provider/model length (mirrors the host). */
const FIELD_BOUND = 256
const MODELS_BOUND = 64

/** One endpoint row as the editor renders it (strings keep typing free). */
interface EndpointDraft {
  id: string
  name: string
  provider: string
  models: string
  defaultModel: string
  maxConcurrency: string
  maxTokens: string
  allowedStart: string
  allowedEnd: string
  offPeakOnly: boolean
  offPeakStart: string
  offPeakEnd: string
  offPeakTimezone: string
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

function viewToDraft(view: EndpointEditorView): EndpointDraft {
  return {
    id: view.id,
    name: view.name,
    provider: view.provider,
    models: view.models.join(', '),
    defaultModel: view.defaultModel,
    maxConcurrency: String(view.maxConcurrency),
    maxTokens: String(view.maxTokens),
    allowedStart: view.allowedHours.start,
    allowedEnd: view.allowedHours.end,
    offPeakOnly: view.offPeakOnly,
    offPeakStart: view.offPeak.start,
    offPeakEnd: view.offPeak.end,
    offPeakTimezone: view.offPeak.timezone,
  }
}

function blankDraft(index: number): EndpointDraft {
  return {
    id: `endpoint-${index}`,
    name: '',
    provider: '',
    models: '',
    defaultModel: '',
    maxConcurrency: '1',
    maxTokens: '0',
    allowedStart: '',
    allowedEnd: '',
    offPeakOnly: false,
    offPeakStart: '16:30',
    offPeakEnd: '00:30',
    offPeakTimezone: 'UTC',
  }
}

function clockOrEmpty(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || CLOCK.test(trimmed)
}

function clockPairValid(start: string, end: string): boolean {
  return (start.trim() === '') === (end.trim() === '')
}

function modelsOf(text: string): string[] {
  return [...new Set(text.split(',').map(part => part.trim()).filter(part => part !== ''))]
}

function draftToView(row: EndpointDraft): EndpointEditorView {
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    provider: row.provider.trim(),
    models: modelsOf(row.models),
    defaultModel: row.defaultModel.trim(),
    maxConcurrency: Number(row.maxConcurrency.trim() === '' ? 1 : row.maxConcurrency),
    maxTokens: Number(row.maxTokens.trim() === '' ? 0 : row.maxTokens),
    allowedHours: { start: row.allowedStart.trim(), end: row.allowedEnd.trim() },
    offPeakOnly: row.offPeakOnly,
    offPeak: {
      start: row.offPeakStart.trim() === '' ? '16:30' : row.offPeakStart.trim(),
      end: row.offPeakEnd.trim() === '' ? '00:30' : row.offPeakEnd.trim(),
      timezone: row.offPeakTimezone.trim() === '' ? 'UTC' : row.offPeakTimezone.trim(),
    },
  }
}

/** Props the settings card binds for the editor. */
export interface EndpointsEditorProps {
  /** Locale reader for this card's copy. */
  t: (key: TaskBoardKey, params?: Record<string, string | number>) => string
  /** Disable every control (read-only settings document). */
  disabled: boolean
}

/**
 * Render the endpoints editor.
 * @param props - locale copy and writability.
 * @returns the editor, fetching the current endpoints on mount and applying a
 *   full replacement on Save.
 */
export function EndpointsEditor(props: EndpointsEditorProps) {
  const { t, disabled } = props
  const [rows, setRows] = useState<EndpointDraft[]>([])
  const [defaultOrder, setDefaultOrder] = useState<string[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [invalid, setInvalid] = useState<Record<number, string>>({})

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    void fetch('/api/task-board/endpoints', { signal: controller.signal, headers: { 'sec-fetch-site': 'same-origin' } })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json() as {
          endpoints?: EndpointEditorView[]
          defaultEndpoints?: string[]
          providers?: string[]
        }
        if (!live) return
        setRows((body.endpoints ?? []).map(viewToDraft))
        setDefaultOrder(body.defaultEndpoints ?? [])
        setProviders(body.providers ?? [])
      })
      .catch(() => { if (live) setUnavailable(true) })
    return () => { live = false; controller.abort() }
  }, [])

  const patchRow = (index: number, patch: Partial<EndpointDraft>): void => {
    setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row))
    setInvalid(current => {
      if (current[index] === undefined) return current
      const next = { ...current }
      delete next[index]
      return next
    })
    setSaved(false)
    setError(undefined)
  }

  const addRow = (): void => {
    setRows(current => [...current, blankDraft(current.length + 1)])
    setError(undefined)
  }

  const removeRow = (index: number): void => {
    setRows(current => {
      const removed = current[index]
      if (removed !== undefined && removed.id.trim() !== '') {
        setDefaultOrder(order => order.filter(id => id !== removed.id.trim()))
      }
      return current.filter((_, i) => i !== index)
    })
    setInvalid(current => {
      const next = { ...current }
      delete next[index]
      return next
    })
    setError(undefined)
  }

  const moveRow = (index: number, delta: number): void => {
    setRows(current => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
    setError(undefined)
  }

  /** Validate every row and return per-row messages (or undefined when clean). */
  const validate = (): Record<number, string> => {
    const messages: Record<number, string> = {}
    const seen = new Set<string>()
    for (const [index, row] of rows.entries()) {
      const id = row.id.trim()
      if (id === '') messages[index] = t('settings.endpointInvalidId')
      else if (id.length > FIELD_BOUND) messages[index] = t('settings.endpointInvalidId')
      else if (seen.has(id)) messages[index] = t('settings.endpointDuplicateId')
      else seen.add(id)
      if (messages[index] === undefined && row.provider.trim() === '') {
        messages[index] = t('settings.endpointInvalidProvider')
      }
      if (messages[index] === undefined) {
        const concurrency = Number(row.maxConcurrency.trim() === '' ? 1 : row.maxConcurrency)
        const tokens = Number(row.maxTokens.trim() === '' ? 0 : row.maxTokens)
        if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(tokens) || tokens < 0) {
          messages[index] = t('settings.endpointInvalidNumber')
        }
      }
      if (messages[index] === undefined && (!clockPairValid(row.allowedStart, row.allowedEnd) || !clockPairValid(row.offPeakStart, row.offPeakEnd))) {
        messages[index] = t('settings.endpointInvalidTime')
      }
      if (messages[index] === undefined && (!clockOrEmpty(row.allowedStart) || !clockOrEmpty(row.allowedEnd) || !clockOrEmpty(row.offPeakStart) || !clockOrEmpty(row.offPeakEnd))) {
        messages[index] = t('settings.endpointInvalidTime')
      }
      if (messages[index] === undefined) {
        const models = modelsOf(row.models)
        if (models.length > MODELS_BOUND || models.some(model => model.length > FIELD_BOUND)) {
          messages[index] = t('settings.endpointInvalidModels')
        }
      }
    }
    return messages
  }

  const save = async (): Promise<void> => {
    const messages = validate()
    if (Object.keys(messages).length > 0) {
      setInvalid(messages)
      setError(undefined)
      return
    }
    setBusy(true)
    setSaved(false)
    setError(undefined)
    try {
      const response = await fetch('/api/task-board/endpoints', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ endpoints: rows.map(draftToView), defaultEndpoints: defaultOrder }),
      })
      const payload = await response.json().catch(() => null) as { endpoints?: EndpointEditorView[]; defaultEndpoints?: string[]; error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      if (payload?.endpoints === undefined) throw new Error('endpoints response missing endpoints')
      setRows(payload.endpoints.map(viewToDraft))
      setDefaultOrder(payload.defaultEndpoints ?? [])
      setSaved(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/api/task-board/endpoints', { headers: { 'sec-fetch-site': 'same-origin' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { endpoints?: EndpointEditorView[]; defaultEndpoints?: string[]; providers?: string[] }
      setRows((body.endpoints ?? []).map(viewToDraft))
      setDefaultOrder(body.defaultEndpoints ?? [])
      setProviders(body.providers ?? [])
      setInvalid({})
      setSaved(false)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError))
    } finally {
      setBusy(false)
    }
  }

  const orderedOptions = rows
    .map((row, index) => ({ id: row.id.trim(), name: row.name.trim() !== '' ? row.name.trim() : row.id.trim(), index }))
    .filter(option => option.id !== '')
  const orderedById = new Map(orderedOptions.map(option => [option.id, option]))
  const remaining = orderedOptions.filter(option => !defaultOrder.includes(option.id))

  return (
    <div className={css.section} data-dsh-part="endpoints-editor">
      <div className={css.head}>
        <span className={css.title}>{t('settings.endpoints')}</span>
        <p className={css.hint}>{t('settings.endpointsHint')}</p>
      </div>
      {unavailable
        ? <p className={css.status} role="status">{t('settings.endpointUnavailable')}</p>
        : rows.length === 0
          ? <p className={css.status}>{t('settings.endpointEmpty')}</p>
          : rows.map((row, index) => (
            <div className={css.row} key={`${index}-${row.id}`} data-endpoint={row.id || `row-${index}`}>
              <div className={css.rowHead}>
                <span className={css.rowIndex}>{index + 1}</span>
                <span className={css.rowName}>{row.name.trim() !== '' ? row.name.trim() : row.id || t('settings.endpointNew')}</span>
                <span className={css.rowActions}>
                  <button type="button" className={css.iconButton} disabled={busy || disabled || index === 0} aria-label={t('settings.endpointMoveUp')} onClick={() => { moveRow(index, -1) }}>↑</button>
                  <button type="button" className={css.iconButton} disabled={busy || disabled || index === rows.length - 1} aria-label={t('settings.endpointMoveDown')} onClick={() => { moveRow(index, 1) }}>↓</button>
                  <button type="button" className={css.iconButton} disabled={busy || disabled} aria-label={t('settings.endpointRemove')} onClick={() => { removeRow(index) }}>×</button>
                </span>
              </div>
              <div className={css.fields}>
                <label className={css.field} htmlFor={`endpoint-id-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointId')}</span>
                  <input id={`endpoint-id-${index}`} className={css.input} type="text" value={row.id} disabled={busy || disabled} onChange={event => { patchRow(index, { id: event.target.value }) }} />
                </label>
                <label className={css.field} htmlFor={`endpoint-name-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointName')}</span>
                  <input id={`endpoint-name-${index}`} className={css.input} type="text" value={row.name} disabled={busy || disabled} onChange={event => { patchRow(index, { name: event.target.value }) }} />
                </label>
                <label className={css.field} htmlFor={`endpoint-provider-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointProvider')}</span>
                  <input id={`endpoint-provider-${index}`} className={css.input} type="text" list="endpoint-providers" value={row.provider} disabled={busy || disabled} onChange={event => { patchRow(index, { provider: event.target.value }) }} />
                </label>
                <label className={css.fieldWide} htmlFor={`endpoint-models-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointModels')}</span>
                  <input id={`endpoint-models-${index}`} className={css.input} type="text" value={row.models} disabled={busy || disabled} onChange={event => { patchRow(index, { models: event.target.value }) }} />
                </label>
                <label className={css.field} htmlFor={`endpoint-default-model-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointDefaultModel')}</span>
                  <input id={`endpoint-default-model-${index}`} className={css.input} type="text" value={row.defaultModel} disabled={busy || disabled} onChange={event => { patchRow(index, { defaultModel: event.target.value }) }} />
                </label>
                <label className={css.fieldSmall} htmlFor={`endpoint-concurrency-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointMaxConcurrency')}</span>
                  <input id={`endpoint-concurrency-${index}`} className={css.input} type="text" inputMode="numeric" value={row.maxConcurrency} disabled={busy || disabled} onChange={event => { patchRow(index, { maxConcurrency: event.target.value }) }} />
                </label>
                <label className={css.fieldSmall} htmlFor={`endpoint-tokens-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointMaxTokens')}</span>
                  <input id={`endpoint-tokens-${index}`} className={css.input} type="text" inputMode="numeric" value={row.maxTokens} disabled={busy || disabled} onChange={event => { patchRow(index, { maxTokens: event.target.value }) }} />
                </label>
                <label className={css.field} htmlFor={`endpoint-allowed-start-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointAllowedHours')}</span>
                  <span className={css.windowPair}>
                    <input id={`endpoint-allowed-start-${index}`} className={css.input} type="text" placeholder="09:00" value={row.allowedStart} disabled={busy || disabled} onChange={event => { patchRow(index, { allowedStart: event.target.value }) }} />
                    <span className={css.windowDash}>–</span>
                    <input id={`endpoint-allowed-end-${index}`} className={css.input} type="text" placeholder="23:00" value={row.allowedEnd} disabled={busy || disabled} onChange={event => { patchRow(index, { allowedEnd: event.target.value }) }} />
                  </span>
                </label>
                <label className={css.field} htmlFor={`endpoint-offpeak-start-${index}`}>
                  <span className={css.fieldLabel}>{t('settings.endpointOffPeak')}</span>
                  <span className={css.windowPair}>
                    <input id={`endpoint-offpeak-start-${index}`} className={css.input} type="text" value={row.offPeakStart} disabled={busy || disabled} onChange={event => { patchRow(index, { offPeakStart: event.target.value }) }} />
                    <span className={css.windowDash}>–</span>
                    <input id={`endpoint-offpeak-end-${index}`} className={css.input} type="text" value={row.offPeakEnd} disabled={busy || disabled} onChange={event => { patchRow(index, { offPeakEnd: event.target.value }) }} />
                    <input id={`endpoint-offpeak-tz-${index}`} className={css.input} type="text" value={row.offPeakTimezone} disabled={busy || disabled} onChange={event => { patchRow(index, { offPeakTimezone: event.target.value }) }} />
                  </span>
                </label>
                <label className={css.checkField} htmlFor={`endpoint-offpeak-only-${index}`}>
                  <input id={`endpoint-offpeak-only-${index}`} className={css.checkbox} type="checkbox" checked={row.offPeakOnly} disabled={busy || disabled} onChange={event => { patchRow(index, { offPeakOnly: event.target.checked }) }} />
                  <span>{t('settings.endpointOffPeakOnly')}</span>
                </label>
              </div>
              {invalid[index] !== undefined ? <p className={css.invalid} role="alert">{invalid[index]}</p> : null}
            </div>
          ))}
      <datalist id="endpoint-providers">
        {providers.map(provider => <option key={provider} value={provider} />)}
      </datalist>
      {!unavailable && (
        <button type="button" className={css.add} disabled={busy || disabled} onClick={addRow}>
          {t('settings.endpointAdd')}
        </button>
      )}
      {!unavailable && rows.length > 0 && (
        <div className={css.defaultOrder} data-dsh-part="default-endpoints">
          <div className={css.defaultOrderHead}>
            <span className={css.defaultOrderTitle}>{t('settings.endpointDefaultOrder')}</span>
            <span className={css.defaultOrderHint}>{t('settings.endpointDefaultOrderHint')}</span>
          </div>
          {defaultOrder.length === 0
            ? <p className={css.status}>{t('settings.endpointDefaultOrderEmpty')}</p>
            : (
              <ol className={css.orderList}>
                {defaultOrder.map((id, index) => {
                  const option = orderedById.get(id)
                  return (
                    <li key={id} className={css.orderRow}>
                      <span className={css.orderName}>{option?.name ?? id}</span>
                      <span className={css.rowActions}>
                        <button type="button" className={css.iconButton} disabled={busy || disabled || index === 0} aria-label={t('settings.endpointMoveUp')} onClick={() => { setDefaultOrder(order => { const next = [...order]; const target = index - 1; if (target < 0) return order; [next[index], next[target]] = [next[target]!, next[index]!]; return next }) }}>↑</button>
                        <button type="button" className={css.iconButton} disabled={busy || disabled || index === defaultOrder.length - 1} aria-label={t('settings.endpointMoveDown')} onClick={() => { setDefaultOrder(order => { const next = [...order]; const target = index + 1; if (target >= next.length) return order; [next[index], next[target]] = [next[target]!, next[index]!]; return next }) }}>↓</button>
                        <button type="button" className={css.iconButton} disabled={busy || disabled} aria-label={t('settings.endpointRemove')} onClick={() => { setDefaultOrder(order => order.filter(item => item !== id)) }}>×</button>
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          {remaining.length > 0 && (
            <select
              className={css.select}
              value=""
              disabled={busy || disabled}
              aria-label={t('settings.endpointAdd')}
              onChange={event => {
                if (event.target.value === '') return
                setDefaultOrder(order => [...order, event.target.value])
              }}
            >
              <option value="">{t('settings.endpointAdd')}…</option>
              {remaining.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          )}
        </div>
      )}
      {!unavailable && (
        <div className={css.actions}>
          <button type="button" className={css.save} disabled={busy || disabled} onClick={() => { void save() }}>
            {t('settings.endpointSave')}
          </button>
          <button type="button" className={css.reset} disabled={busy || disabled} onClick={() => { void reset() }}>
            {t('settings.endpointReset')}
          </button>
          {saved ? <span className={css.saved} role="status">{t('settings.endpointSaved')}</span> : null}
          {error !== undefined ? <span className={css.error} role="alert">{t('settings.endpointError', { error })}</span> : null}
        </div>
      )}
    </div>
  )
}
