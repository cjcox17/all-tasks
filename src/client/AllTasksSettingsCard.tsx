/**
 * All-tasks settings for availability, agent announcement, and optional Host
 * idle-sleep protection. Registers into the official `settings.plugin.item`
 * keyed slot (the Plugins section's configurable tab) under the `all-tasks`
 * namespace key, bound to the `all-tasks` namespace.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useState } from 'react'
import type { AllTasksPowerSnapshot } from '../protocol.ts'
import { EndpointsEditor } from './EndpointsEditor.tsx'
import { PluginSettingsCard, BooleanField } from './PluginSettingsCard.tsx'
import { CardForm, booleanField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'

/** The all-tasks fields this card edits (the namespace's full schema). */
export interface AllTasksSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Whether the board announces itself in every agent's system prompt. */
  announceToAgent?: boolean
  /** Prevent host idle sleep while sessions run or schedules are armed. */
  preventIdleSleep?: boolean
  /** Show message/tool times and per-turn token counts in the session view. */
  sessionTimestamps?: boolean
  /** Auto-generate a task title from the run prompt in the new-task dialog. */
  autoTitle?: boolean
  /** How long a queued run may wait for an eligible endpoint before failing (hours). */
  endpointMaxWaitHours?: number
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints?: string[]
  /** Named compute endpoints the router routes tasks through. */
  endpoints?: Array<{
    id: string
    name?: string
    provider?: string
    models?: string[]
    defaultModel?: string
    costPerMillionInputTokens?: number
    costPerMillionOutputTokens?: number
  }>
}

/** What the all-tasks card renders. */
export interface AllTasksSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  /** Idle-system-sleep protection flag. */
  preventIdleSleep: CardFieldState
  /** Session-view timestamp/token flag. */
  sessionTimestamps: CardFieldState
  /** Auto-generated-title flag. */
  autoTitle: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface AllTasksSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAllTasksSettingsCard. */
    allTasksSettingsCard: SnapshotStore<AllTasksSettingsCardState>
  }
}

/** Bridges the `all-tasks` scope onto the card's staged form. */
export class AllTasksSettingsCardController {
  private readonly form: CardForm<AllTasksSettings>
  private readonly store: SnapshotStore<AllTasksSettingsCardState>

  /** @param scope - the bound settings scope for the `all-tasks` namespace. */
  constructor(scope: SettingsScope<AllTasksSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('preventIdleSleep'),
      booleanField('sessionTimestamps'),
      booleanField('autoTitle'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): AllTasksSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      preventIdleSleep: this.form.field('preventIdleSleep'),
      sessionTimestamps: this.form.field('sessionTimestamps'),
      autoTitle: this.form.field('autoTitle'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): AllTasksSettingsCardFace {
    return { hooks: { allTasksSettingsCard: this.store }, ...this.form.actions() }
  }

  /**
   * Release the card's scope subscription and bound stores; the slot
   * disposer calls this on teardown.
   */
  dispose(): void {
    this.form.dispose()
  }
}

/** Props the renderer binds for the all-tasks card. */
export type AllTasksSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'all-tasks'>
  & InjectFace<AllTasksSettingsCardFace>

/**
 * Render the all-tasks card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AllTasksSettingsCard(props: AllTasksSettingsCardProps) {
  const { t } = props
  const state = props.useAllTasksSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const [power, setPower] = useState<AllTasksPowerSnapshot | undefined>()
  useEffect(() => {
    // The SSE channel already carries power on every real change and pushes
    // one frame on subscribe; polling the full /state snapshot every 5 s
    // re-cloned and re-serialized the whole ledger server-side for one field.
    let live = true
    const events = new EventSource('/api/all-tasks/events')
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const frame = JSON.parse(message.data) as { power?: AllTasksPowerSnapshot }
        if (frame.power !== undefined && live) setPower(frame.power)
      } catch {
        // The settings form remains usable while the host status is reconnecting.
      }
    }
    return () => { live = false; events.close() }
  }, [])
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      defaultOpen={false}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="settings-all-tasks-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <BooleanField
        id="settings-all-tasks-announce"
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
      <BooleanField
        id="settings-all-tasks-prevent-idle-sleep"
        label={t('settings.preventIdleSleep')}
        hint={t('settings.preventIdleSleepHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.preventIdleSleep}
        onEdit={(text) => { props.edit('preventIdleSleep', text) }}
        onReset={() => { props.resetField('preventIdleSleep') }}
      />
      <BooleanField
        id="settings-all-tasks-session-timestamps"
        label={t('settings.sessionTimestamps')}
        hint={t('settings.sessionTimestampsHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.sessionTimestamps}
        onEdit={(text) => { props.edit('sessionTimestamps', text) }}
        onReset={() => { props.resetField('sessionTimestamps') }}
      />
      <BooleanField
        id="settings-all-tasks-auto-title"
        label={t('settings.autoTitle')}
        hint={t('settings.autoTitleHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.autoTitle}
        onEdit={(text) => { props.edit('autoTitle', text) }}
        onReset={() => { props.resetField('autoTitle') }}
      />
      <EndpointsEditor t={t} disabled={disabled} />
      <p>
        {t('settings.powerStatus', {
          platform: power?.platform ?? t('settings.powerUnknown'),
          phase: power?.phase ?? t('settings.powerUnknown'),
          running: String(power?.runningSessions ?? 0),
          schedules: String(power?.armedSchedules ?? 0),
        })}
      </p>
      <p>{t('settings.powerBoundary')}</p>
      {power?.lastError !== undefined && <p>{t('settings.powerError', { error: power.lastError })}</p>}
    </PluginSettingsCard>
  )
}
