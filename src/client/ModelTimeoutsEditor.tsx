/**
 * Model default timeouts editor for the task-board settings card.
 *
 * DSH aborts a model request when no new content arrives for 300 seconds (the
 * stream-idle watchdog) — a local LLM recomputing a long message chain or
 * generating slowly trips it even though the backend is still working. This
 * editor lists every configurable provider (custom/local `llm-pi-ai` routes
 * plus the official `deepseek-official` route) with its current effective idle
 * timeout and writes a raised default straight into the DSH provider settings
 * through the board's own HTTP routes. The change applies live to the next
 * request through that provider — chat and task runs alike — and is validated
 * by DSH's own settings schema.
 */

import { useEffect, useState } from 'react'
import type { ModelTimeoutView } from '../model-timeouts.ts'
import type { TaskBoardKey } from './locales.ts'
import css from './model-timeouts.module.css'

/** Upper bound the editor accepts (seconds): DSH allows up to ~24.8 days. */
const MAX_SECONDS = 86_400

/** One provider row as the editor renders it. */
interface ModelTimeoutRow {
  provider: string
  displayName: string
  namespace: 'llm-pi-ai' | 'llm-deepseek'
  /** Editable idle timeout in seconds (string state keeps typing free). */
  idleSeconds: string
  /** Editable total request timeout in seconds; '' = backend default. */
  totalSeconds: string
  /** Transient "saved" confirmation for this row. */
  saved: boolean
  /** Client-side validation failure for this row. */
  invalid: string | undefined
}

/** Props the settings card binds for the editor. */
export interface ModelTimeoutsEditorProps {
  /** Locale reader for this card's copy. */
  t: (key: TaskBoardKey, params?: Record<string, string | number>) => string
  /** Disable every control (read-only settings document). */
  disabled: boolean
}

function secondsOf(value: number | undefined): string {
  return value === undefined ? '' : String(Math.round(value / 1000))
}

function toRow(view: ModelTimeoutView): ModelTimeoutRow {
  return {
    provider: view.provider,
    displayName: view.displayName,
    namespace: view.namespace,
    idleSeconds: secondsOf(view.streamIdleTimeoutMs),
    totalSeconds: secondsOf(view.timeoutMs),
    saved: false,
    invalid: undefined,
  }
}

function parseSeconds(text: string): number | undefined {
  const value = Number(text.trim())
  return Number.isInteger(value) && value >= 1 && value <= MAX_SECONDS ? value : undefined
}

/**
 * Render the model default timeouts editor.
 * @param props - locale copy and writability.
 * @returns the editor, fetching the current values on mount and applying
 *   per-provider writes immediately.
 */
export function ModelTimeoutsEditor(props: ModelTimeoutsEditorProps) {
  const { t, disabled } = props
  const [rows, setRows] = useState<ModelTimeoutRow[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [busyProvider, setBusyProvider] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    void fetch('/api/task-board/model-timeouts', { signal: controller.signal, headers: { 'sec-fetch-site': 'same-origin' } })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json() as { providers?: ModelTimeoutView[] }
        if (live) setRows((body.providers ?? []).map(toRow))
      })
      .catch(() => { if (live) setUnavailable(true) })
    return () => { live = false; controller.abort() }
  }, [])

  const editRow = (row: ModelTimeoutRow, field: 'idle' | 'total', text: string): void => {
    setRows(current => current.map(candidate => {
      if (candidate.provider !== row.provider) return candidate
      const next = { ...candidate }
      if (field === 'idle') next.idleSeconds = text
      else next.totalSeconds = text
      next.invalid = undefined
      next.saved = false
      return next
    }))
  }

  const postPatch = async (provider: string, patch: { streamIdleTimeoutMs: number | null; timeoutMs?: number | null }): Promise<ModelTimeoutRow> => {
    const response = await fetch('/api/task-board/model-timeouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ provider, ...patch }),
    })
    const payload = await response.json().catch(() => null) as { provider?: ModelTimeoutView; error?: string } | null
    if (!response.ok) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`)
    }
    if (payload?.provider === undefined) throw new Error('model-timeouts response missing provider')
    return toRow(payload.provider)
  }

  const saveRow = async (row: ModelTimeoutRow): Promise<void> => {
    const idle = parseSeconds(row.idleSeconds)
    if (idle === undefined) {
      setRows(current => current.map(candidate => candidate.provider === row.provider
        ? { ...candidate, invalid: t('settings.modelTimeoutInvalid') }
        : candidate))
      return
    }
    let total: number | null = null
    if (row.totalSeconds.trim() !== '') {
      const parsed = parseSeconds(row.totalSeconds)
      if (parsed === undefined) {
        setRows(current => current.map(candidate => candidate.provider === row.provider
          ? { ...candidate, invalid: t('settings.modelTimeoutInvalid') }
          : candidate))
        return
      }
      total = parsed
    }
    setBusyProvider(row.provider)
    try {
      const updated = await postPatch(row.provider, {
        streamIdleTimeoutMs: idle * 1000,
        ...(row.namespace === 'llm-pi-ai' ? { timeoutMs: total === null ? null : total * 1000 } : {}),
      })
      setRows(current => current.map(candidate => candidate.provider === row.provider ? { ...updated, saved: true } : candidate))
    } catch (error) {
      setRows(current => current.map(candidate => candidate.provider === row.provider
        ? { ...candidate, invalid: t('settings.modelTimeoutError', { error: error instanceof Error ? error.message : String(error) }) }
        : candidate))
    } finally {
      setBusyProvider(undefined)
    }
  }

  const resetRow = async (row: ModelTimeoutRow): Promise<void> => {
    setBusyProvider(row.provider)
    try {
      const updated = await postPatch(row.provider, {
        streamIdleTimeoutMs: null,
        ...(row.namespace === 'llm-pi-ai' ? { timeoutMs: null } : {}),
      })
      setRows(current => current.map(candidate => candidate.provider === row.provider ? { ...updated, saved: true } : candidate))
    } catch (error) {
      setRows(current => current.map(candidate => candidate.provider === row.provider
        ? { ...candidate, invalid: t('settings.modelTimeoutError', { error: error instanceof Error ? error.message : String(error) }) }
        : candidate))
    } finally {
      setBusyProvider(undefined)
    }
  }

  return (
    <div className={css.section} data-dsh-part="model-timeouts">
      <div className={css.head}>
        <span className={css.title}>{t('settings.modelTimeouts')}</span>
        <p className={css.hint}>{t('settings.modelTimeoutsHint')}</p>
      </div>
      {unavailable
        ? <p className={css.status} role="status">{t('settings.modelTimeoutUnavailable')}</p>
        : rows.length === 0
          ? <p className={css.status}>{t('settings.modelTimeoutEmpty')}</p>
          : rows.map(row => {
            const busy = busyProvider === row.provider
            const rowDisabled = disabled || busy
            return (
              <div className={css.row} key={row.provider} data-provider={row.provider}>
                <div className={css.rowHead}>
                  <span className={css.rowName}>{row.displayName}</span>
                  <span className={css.rowProvider}>{row.provider}</span>
                </div>
                <div className={css.fields}>
                  <label className={css.field} htmlFor={`model-timeout-idle-${row.provider}`}>
                    <span className={css.fieldLabel}>{t('settings.modelTimeoutIdle')}</span>
                    <input
                      id={`model-timeout-idle-${row.provider}`}
                      className={css.input}
                      type="text"
                      inputMode="numeric"
                      value={row.idleSeconds}
                      disabled={rowDisabled}
                      onChange={event => { editRow(row, 'idle', event.target.value) }}
                    />
                    <span className={css.fieldHint}>{t('settings.modelTimeoutIdleHint')}</span>
                  </label>
                  {row.namespace === 'llm-pi-ai'
                    ? (
                      <label className={css.field} htmlFor={`model-timeout-total-${row.provider}`}>
                        <span className={css.fieldLabel}>{t('settings.modelTimeoutTotal')}</span>
                        <input
                          id={`model-timeout-total-${row.provider}`}
                          className={css.input}
                          type="text"
                          inputMode="numeric"
                          value={row.totalSeconds}
                          disabled={rowDisabled}
                          onChange={event => { editRow(row, 'total', event.target.value) }}
                        />
                        <span className={css.fieldHint}>{t('settings.modelTimeoutTotalHint')}</span>
                      </label>
                    )
                    : null}
                </div>
                {row.invalid !== undefined ? <p className={css.invalid} role="alert">{row.invalid}</p> : null}
                <div className={css.actions}>
                  <button
                    type="button"
                    className={css.save}
                    disabled={rowDisabled}
                    onClick={() => { void saveRow(row) }}
                  >
                    {t('settings.modelTimeoutSave')}
                  </button>
                  <button
                    type="button"
                    className={css.reset}
                    disabled={rowDisabled}
                    onClick={() => { void resetRow(row) }}
                  >
                    {t('settings.modelTimeoutReset')}
                  </button>
                  {row.saved ? <span className={css.saved} role="status">{t('settings.modelTimeoutSaved')}</span> : null}
                </div>
              </div>
            )
          })}
    </div>
  )
}
