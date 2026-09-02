/**
 * Endpoints editor for the all-tasks settings card.
 *
 * Endpoints are the compute targets the endpoint model-router routes tasks
 * through (DeepSeek Official, an LM Studio on the NAS, …). They live in the
 * plugin's own `all-tasks` settings namespace; before this editor the only
 * way to configure them was editing `~/.dsh/settings.yaml` by hand, so the
 * task modal's Endpoints dropdown stayed empty.
 *
 * An endpoint is deliberately lean: pick one provider route, then narrow that
 * provider's models and pick a default model among them. Provider-level
 * concerns (concurrency, token caps, windows) stay in the provider's own
 * settings. The only per-endpoint tunables beyond the selection are the model
 * request timeouts (idle + total), which write through to the provider
 * route's settings — the only place DSH honors them. This section reads the
 * current endpoints through the board's own HTTP routes and writes a full
 * replacement immediately (one Save for the whole list), so the modal
 * dropdown and the router pick the change up live — no restart.
 */

import { useEffect, useState } from 'react'
import type { EndpointEditorView, EndpointProviderInfo } from '../endpoint-editor.ts'
import type { AllTasksKey } from './locales.ts'
import css from './endpoints-editor.module.css'

/** Bound on endpoint id/name/provider/model length (mirrors the host). */
const FIELD_BOUND = 256
const MODELS_BOUND = 64
const TIMEOUT_BOUND = 86_400

/** One endpoint row as the editor renders it (strings keep typing free). */
interface EndpointDraft {
  id: string
  name: string
  provider: string
  /** Selected model ids (checkbox picks from the provider's model list). */
  models: string[]
  defaultModel: string
  /** Editable idle timeout in seconds. */
  idleSeconds: string
  /** Editable total request timeout in seconds; '' = unset (pi-ai only). */
  totalSeconds: string
  /** Local pricing: USD per 1M input tokens; '' = not configured. */
  costInput: string
  /** Local pricing: USD per 1M output tokens; '' = not configured. */
  costOutput: string
}

function viewToDraft(view: EndpointEditorView): EndpointDraft {
  return {
    id: view.id,
    name: view.name,
    provider: view.provider,
    models: [...view.models],
    defaultModel: view.defaultModel,
    idleSeconds: String(view.idleSeconds),
    totalSeconds: view.totalSeconds > 0 ? String(view.totalSeconds) : '',
    costInput: view.costPerMillionInputTokens > 0 ? String(view.costPerMillionInputTokens) : '',
    costOutput: view.costPerMillionOutputTokens > 0 ? String(view.costPerMillionOutputTokens) : '',
  }
}

function blankDraft(index: number): EndpointDraft {
  return {
    id: `endpoint-${index}`,
    name: '',
    provider: '',
    models: [],
    defaultModel: '',
    idleSeconds: '300',
    totalSeconds: '',
    costInput: '',
    costOutput: '',
  }
}

function parseSeconds(text: string, allowZero: boolean): number | undefined {
  const value = Number(text.trim())
  if (!Number.isInteger(value)) return undefined
  if (value < (allowZero ? 0 : 1) || value > TIMEOUT_BOUND) return undefined
  return value
}

/** Parse a local price (USD per 1M tokens): '' or 0 = unset, else a finite non-negative number. */
function parsePrice(text: string): number | undefined {
  if (text.trim() === '') return 0
  const value = Number(text.trim())
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

function draftToView(row: EndpointDraft): EndpointEditorView {
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    provider: row.provider.trim(),
    models: [...new Set(row.models.map(model => model.trim()).filter(model => model !== ''))],
    defaultModel: row.defaultModel.trim(),
    idleSeconds: parseSeconds(row.idleSeconds, false) ?? 300,
    totalSeconds: parseSeconds(row.totalSeconds, true) ?? 0,
    costPerMillionInputTokens: parsePrice(row.costInput) ?? 0,
    costPerMillionOutputTokens: parsePrice(row.costOutput) ?? 0,
  }
}

/** Props the settings card binds for the editor. */
export interface EndpointsEditorProps {
  /** Locale reader for this card's copy. */
  t: (key: AllTasksKey, params?: Record<string, string | number>) => string
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
  const [providers, setProviders] = useState<EndpointProviderInfo[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [invalid, setInvalid] = useState<Record<number, string>>({})

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    void fetch('/api/all-tasks/endpoints', { signal: controller.signal, headers: { 'sec-fetch-site': 'same-origin' } })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json() as {
          endpoints?: EndpointEditorView[]
          defaultEndpoints?: string[]
          providers?: EndpointProviderInfo[]
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

  /**
   * Change a row's provider: clear models/defaultModel so they re-pick from
   * the new provider's list. Switching to the official DeepSeek route also
   * drops the local price drafts (that route bills its hard-coded official
   * rates, so the hidden fields would otherwise linger in storage unused).
   */
  const changeProvider = (index: number, provider: string): void => {
    const officialDeepSeek = providers.find(candidate => candidate.provider === provider)?.namespace === 'llm-deepseek'
    patchRow(index, {
      provider,
      models: [],
      defaultModel: '',
      ...(officialDeepSeek ? { costInput: '', costOutput: '' } : {}),
    })
  }

  const toggleModel = (index: number, model: string): void => {
    setRows(current => current.map((row, i) => {
      if (i !== index) return row
      const models = row.models.includes(model)
        ? row.models.filter(candidate => candidate !== model)
        : [...row.models, model]
      const defaultModel = models.includes(row.defaultModel) ? row.defaultModel : ''
      return { ...row, models, defaultModel }
    }))
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

  /** The provider's model list when known (the checkbox source); empty = free text fallback. */
  const providerModelsOf = (row: EndpointDraft): string[] => {
    const info = providers.find(candidate => candidate.provider === row.provider)
    return info?.models ?? []
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
      if (messages[index] === undefined && row.name.trim().length > FIELD_BOUND) {
        messages[index] = t('settings.endpointInvalidId')
      }
      if (messages[index] === undefined && row.defaultModel.trim().length > FIELD_BOUND) {
        messages[index] = t('settings.endpointInvalidId')
      }
      if (messages[index] === undefined && parseSeconds(row.idleSeconds, false) === undefined) {
        messages[index] = t('settings.endpointInvalidNumber')
      }
      if (messages[index] === undefined && row.totalSeconds.trim() !== '' && parseSeconds(row.totalSeconds, true) === undefined) {
        messages[index] = t('settings.endpointInvalidNumber')
      }
      // Local pricing only applies to non-official endpoints (the official
      // DeepSeek route bills its hard-coded peak/off-peak rates); still parse
      // the fields so a stray bad value never slips through on save.
      if (messages[index] === undefined && parsePrice(row.costInput) === undefined) {
        messages[index] = t('settings.endpointInvalidPrice')
      }
      if (messages[index] === undefined && parsePrice(row.costOutput) === undefined) {
        messages[index] = t('settings.endpointInvalidPrice')
      }
      if (messages[index] === undefined) {
        const models = [...new Set(row.models.map(model => model.trim()).filter(model => model !== ''))]
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
      const response = await fetch('/api/all-tasks/endpoints', {
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
      const response = await fetch('/api/all-tasks/endpoints', { headers: { 'sec-fetch-site': 'same-origin' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { endpoints?: EndpointEditorView[]; defaultEndpoints?: string[]; providers?: EndpointProviderInfo[] }
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
          : rows.map((row, index) => {
            const providerModels = providerModelsOf(row)
            const knownModels = providerModels.length > 0
            const totalOnly = providers.find(candidate => candidate.provider === row.provider)?.namespace === 'llm-pi-ai'
            // The official DeepSeek route bills its hard-coded peak/off-peak
            // rates automatically; local pricing fields are hidden for it.
            const officialDeepSeek = providers.find(candidate => candidate.provider === row.provider)?.namespace === 'llm-deepseek'
            return (
              <div className={css.row} key={index} data-endpoint={row.id || `row-${index}`}>
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
                    <select
                      id={`endpoint-provider-${index}`}
                      className={css.select}
                      value={row.provider}
                      disabled={busy || disabled}
                      onChange={event => { changeProvider(index, event.target.value) }}
                    >
                      <option value="">{t('settings.endpointProviderPlaceholder')}</option>
                      {providers.map(info => (
                        <option key={info.provider} value={info.provider}>
                          {info.displayName !== info.provider ? `${info.displayName} (${info.provider})` : info.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  {knownModels
                    ? (
                      <div className={css.fieldWide} data-dsh-part={`endpoint-models-${index}`}>
                        <span className={css.fieldLabel}>{t('settings.endpointModels')}</span>
                        <div className={css.modelList}>
                          {providerModels.map(model => (
                            <label className={css.checkField} key={model} htmlFor={`endpoint-model-${index}-${model}`}>
                              <input
                                id={`endpoint-model-${index}-${model}`}
                                className={css.checkbox}
                                type="checkbox"
                                checked={row.models.includes(model)}
                                disabled={busy || disabled}
                                onChange={() => { toggleModel(index, model) }}
                              />
                              <span className={css.modelName}>{model}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )
                    : (
                      <label className={css.fieldWide} htmlFor={`endpoint-models-${index}`}>
                        <span className={css.fieldLabel}>{t('settings.endpointModels')}</span>
                        <input
                          id={`endpoint-models-${index}`}
                          className={css.input}
                          type="text"
                          value={row.models.join(', ')}
                          disabled={busy || disabled}
                          onChange={event => { patchRow(index, { models: event.target.value.split(',').map(part => part.trim()).filter(part => part !== '') }) }}
                        />
                      </label>
                    )}
                  {knownModels && row.models.length > 0
                    ? (
                      <label className={css.field} htmlFor={`endpoint-default-model-${index}`}>
                        <span className={css.fieldLabel}>{t('settings.endpointDefaultModel')}</span>
                        <select
                          id={`endpoint-default-model-${index}`}
                          className={css.select}
                          value={row.defaultModel}
                          disabled={busy || disabled}
                          onChange={event => { patchRow(index, { defaultModel: event.target.value }) }}
                        >
                          <option value="">{t('settings.endpointNone')}</option>
                          {row.models.map(model => <option key={model} value={model}>{model}</option>)}
                        </select>
                      </label>
                    )
                    : (
                      <label className={css.field} htmlFor={`endpoint-default-model-${index}`}>
                        <span className={css.fieldLabel}>{t('settings.endpointDefaultModel')}</span>
                        <input
                          id={`endpoint-default-model-${index}`}
                          className={css.input}
                          type="text"
                          value={row.defaultModel}
                          disabled={busy || disabled}
                          onChange={event => { patchRow(index, { defaultModel: event.target.value }) }}
                        />
                      </label>
                    )}
                  <label className={css.fieldSmall} htmlFor={`endpoint-idle-${index}`}>
                    <span className={css.fieldLabel}>{t('settings.endpointIdleTimeout')}</span>
                    <input
                      id={`endpoint-idle-${index}`}
                      className={css.input}
                      type="text"
                      inputMode="numeric"
                      value={row.idleSeconds}
                      disabled={busy || disabled}
                      onChange={event => { patchRow(index, { idleSeconds: event.target.value }) }}
                    />
                    <span className={css.fieldLabel}>{t('settings.endpointTimeoutSeconds')}</span>
                  </label>
                  {totalOnly && (
                    <label className={css.fieldSmall} htmlFor={`endpoint-total-${index}`}>
                      <span className={css.fieldLabel}>{t('settings.endpointTotalTimeout')}</span>
                      <input
                        id={`endpoint-total-${index}`}
                        className={css.input}
                        type="text"
                        inputMode="numeric"
                        value={row.totalSeconds}
                        disabled={busy || disabled}
                        onChange={event => { patchRow(index, { totalSeconds: event.target.value }) }}
                      />
                      <span className={css.fieldLabel}>{t('settings.endpointTimeoutSeconds')}</span>
                    </label>
                  )}
                  {officialDeepSeek
                    ? <p className={css.officialPricing} data-dsh-part={`endpoint-official-pricing-${index}`}>{t('settings.endpointOfficialPricing')}</p>
                    : (
                      <>
                        <label className={css.fieldSmall} htmlFor={`endpoint-cost-input-${index}`}>
                          <span className={css.fieldLabel}>{t('settings.endpointCostInput')}</span>
                          <input
                            id={`endpoint-cost-input-${index}`}
                            className={css.input}
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={row.costInput}
                            disabled={busy || disabled}
                            onChange={event => { patchRow(index, { costInput: event.target.value }) }}
                          />
                          <span className={css.fieldLabel}>{t('settings.endpointPerMillion')}</span>
                        </label>
                        <label className={css.fieldSmall} htmlFor={`endpoint-cost-output-${index}`}>
                          <span className={css.fieldLabel}>{t('settings.endpointCostOutput')}</span>
                          <input
                            id={`endpoint-cost-output-${index}`}
                            className={css.input}
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={row.costOutput}
                            disabled={busy || disabled}
                            onChange={event => { patchRow(index, { costOutput: event.target.value }) }}
                          />
                          <span className={css.fieldLabel}>{t('settings.endpointPerMillion')}</span>
                        </label>
                      </>
                    )}
                </div>
                {invalid[index] !== undefined ? <p className={css.invalid} role="alert">{invalid[index]}</p> : null}
              </div>
            )
          })}
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
