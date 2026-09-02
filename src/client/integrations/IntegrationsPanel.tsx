/**
 * Events and Actions panels — the read-only center-column views behind the
 * two sidebar entries below All Tasks.
 *
 * Each panel asks the Host for the registered event sources / actions (id,
 * mount facts, resolved config) and renders one card per integration. The
 * Host is the authority on what exists; this component only supplies display
 * copy (per-plugin names, descriptions, config field labels) and falls back
 * to a generic card for integrations it does not know about, so a future
 * plugin is never invisible — just less decorated.
 *
 * Configuration is intentionally not editable here: it lives in the plugin
 * settings (Settings → Plugins → All Tasks), with secrets supplied through
 * environment variables, so the panels only ever show env-var names.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PanelController } from '../../core/panel-controller.ts'
import type { ActionStatus, AllTasksIntegrationsSnapshot, EventSourceStatus } from '../../protocol.ts'
import { fetchIntegrations } from '../integrations.ts'
import { t, type AllTasksKey } from '../locales.ts'
import css from '../board.module.css'

/** One integration's display copy (per-plugin decoration). */
interface IntegrationDescriptor {
  nameKey: AllTasksKey
  descKey: AllTasksKey
  /** Known config keys → their label key; unknown keys render with a raw fallback. */
  configFields: Record<string, AllTasksKey>
}

const EVENT_DESCRIPTORS: Record<string, IntegrationDescriptor> = {
  http: {
    nameKey: 'integration.event.http.name',
    descKey: 'integration.event.http.desc',
    configFields: {
      tokenEnv: 'integration.config.tokenEnv',
      workspaceId: 'integration.config.workspaceId',
      autoRun: 'integration.config.autoRun',
    },
  },
  github: {
    nameKey: 'integration.event.github.name',
    descKey: 'integration.event.github.desc',
    configFields: {
      secretEnv: 'integration.config.secretEnv',
      repoWorkspaces: 'integration.config.repoWorkspaces',
      defaultWorkspaceId: 'integration.config.defaultWorkspaceId',
      autoRun: 'integration.config.autoRun',
    },
  },
  slack: {
    nameKey: 'integration.event.slack.name',
    descKey: 'integration.event.slack.desc',
    configFields: {
      signingSecretEnv: 'integration.config.signingSecretEnv',
      workspaceId: 'integration.config.workspaceId',
      autoRun: 'integration.config.autoRun',
    },
  },
}

const ACTION_DESCRIPTORS: Record<string, IntegrationDescriptor> = {
  http: {
    nameKey: 'integration.action.http.name',
    descKey: 'integration.action.http.desc',
    configFields: {
      url: 'integration.config.url',
      tokenEnv: 'integration.config.tokenEnv',
    },
  },
  github: {
    nameKey: 'integration.action.github.name',
    descKey: 'integration.action.github.desc',
    configFields: {
      tokenEnv: 'integration.config.tokenEnv',
      apiBase: 'integration.config.apiBase',
      repo: 'integration.config.repo',
      issueNumber: 'integration.config.issueNumber',
      commitSha: 'integration.config.commitSha',
    },
  },
  spawn: {
    nameKey: 'integration.action.spawn.name',
    descKey: 'integration.action.spawn.desc',
    configFields: {},
  },
}

function descriptorFor(kind: 'events' | 'actions', id: string): IntegrationDescriptor | undefined {
  return (kind === 'events' ? EVENT_DESCRIPTORS : ACTION_DESCRIPTORS)[id]
}

/** Render one config value for display (env-var names only, never values). */
function configValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return t(value ? 'integration.config.true' : 'integration.config.false')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value === '' ? t('integration.config.unset') : value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return t('integration.config.repoWorkspacesEmpty')
    return entries.map(([name, nested]) => `${name} → ${configValue(name, nested)}`).join(', ')
  }
  if (value === undefined || value === null) return t('integration.config.unset')
  return JSON.stringify(value)
}

/** A config row's label: the descriptor's label, or the raw key as a fallback. */
function configLabel(key: string, descriptor: IntegrationDescriptor | undefined): string {
  const labelKey = descriptor?.configFields[key]
  return labelKey !== undefined ? t(labelKey) : key
}

/** The fetch state of one panel. */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: AllTasksIntegrationsSnapshot }
  | { status: 'error'; error: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fetch the integrations snapshot on mount and refresh every time the panel opens. */
function useIntegrations(controller: PanelController): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const reload = useCallback((): void => {
    setState({ status: 'loading' })
    void fetchIntegrations().then(
      snapshot => setState({ status: 'ready', snapshot }),
      error => setState({ status: 'error', error: messageOf(error) }),
    )
  }, [])
  useEffect(() => {
    // First load, then a refresh on every open (the panel stays mounted under
    // the conversation, so this is the "look at it and see the latest" hook).
    reload()
    return controller.subscribe(() => {
      if (controller.getSnapshot().open) reload()
    })
  }, [controller, reload])
  return { state, reload }
}

/** A config row (dt/dd pair sharing one grid cell column). */
function ConfigRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt className={css.integrationConfigLabel}>{label}</dt>
      <dd
        className={css.integrationConfigValue}
        data-unset={typeof value === 'string' && value === '' ? '' : undefined}
      >
        {configValue(label, value)}
      </dd>
    </div>
  )
}

/** One event source card. */
function EventCard({ source }: { source: EventSourceStatus }) {
  const descriptor = descriptorFor('events', source.id)
  const name = descriptor === undefined ? source.id : t(descriptor.nameKey)
  const description = descriptor === undefined ? t('integration.unknown.desc') : t(descriptor.descKey)
  const configEntries = Object.entries(source.config)
  return (
    <article className={css.integrationCard}>
      <header className={css.integrationHeader}>
        <h3 className={css.integrationName}>{name}</h3>
        <span className={css.integrationChip} title={t('integration.route')}>
          {source.method} {source.path}
        </span>
      </header>
      <p className={css.integrationDesc}>{description}</p>
      {configEntries.length > 0 && (
        <dl className={css.integrationConfig}>
          {configEntries.map(([key, value]) => (
            <ConfigRow key={key} label={configLabel(key, descriptor)} value={value} />
          ))}
        </dl>
      )}
    </article>
  )
}

/** One action card. */
function ActionCard({ action }: { action: ActionStatus }) {
  const descriptor = descriptorFor('actions', action.id)
  const name = descriptor === undefined ? action.id : t(descriptor.nameKey)
  const description = descriptor === undefined ? t('integration.unknown.desc') : t(descriptor.descKey)
  const when = action.when.length === 0
    ? t('integration.when.none')
    : action.when.map(outcome => t(`integration.when.${outcome}` as AllTasksKey)).join(', ')
  const configEntries = Object.entries(action.config)
  return (
    <article className={css.integrationCard}>
      <header className={css.integrationHeader}>
        <h3 className={css.integrationName}>{name}</h3>
        <span className={css.integrationChip} title={t('integration.when')}>{when}</span>
      </header>
      <p className={css.integrationDesc}>{description}</p>
      {configEntries.length > 0 && (
        <dl className={css.integrationConfig}>
          {configEntries.map(([key, value]) => (
            <ConfigRow key={key} label={configLabel(key, descriptor)} value={value} />
          ))}
        </dl>
      )}
    </article>
  )
}

/** The shared panel shell: header (back + title), the card list, and the footer hint. */
function PanelShell(props: {
  controller: PanelController
  title: AllTasksKey
  intro: AllTasksKey
  state: LoadState
  reload: () => void
  children: ReactNode
}) {
  return (
    <div className={css.panel} data-dsh-plugin="all-tasks">
      <header className={css.boardHeader}>
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('panel.close')}
          onClick={() => { props.controller.closePanel() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('panel.close')}</span>
        </button>
        <h2 className={css.boardTitle}>{t(props.title)}</h2>
      </header>
      <p className={css.panelIntro}>{t(props.intro)}</p>
      <div className={css.panelList}>
        {props.state.status === 'loading' && <p className={css.panelEmpty}>{t('panel.loading')}</p>}
        {props.state.status === 'error' && (
          <p className={css.panelError}>
            {t('panel.loadFailed', { error: props.state.error })}{' '}
            <button type="button" className={css.linkButton} onClick={props.reload}>{t('panel.retry')}</button>
          </p>
        )}
        {props.state.status === 'ready' && props.children}
      </div>
      <p className={css.panelConfigureHint}>{t('panel.configureHint')}</p>
    </div>
  )
}

/** The Events panel: every registered inbound event source. */
export function EventsPanel({ controller }: { controller: PanelController }) {
  const { state, reload } = useIntegrations(controller)
  return (
    <PanelShell
      controller={controller}
      title="panel.events.title"
      intro="panel.events.intro"
      state={state}
      reload={reload}
    >
      {state.status === 'ready' && state.snapshot.events.length === 0
        ? <p className={css.panelEmpty}>{t('panel.eventsEmpty')}</p>
        : state.status === 'ready' && state.snapshot.events.map(source => <EventCard key={source.id} source={source} />)}
    </PanelShell>
  )
}

/** The Actions panel: every registered result-side action. */
export function ActionsPanel({ controller }: { controller: PanelController }) {
  const { state, reload } = useIntegrations(controller)
  return (
    <PanelShell
      controller={controller}
      title="panel.actions.title"
      intro="panel.actions.intro"
      state={state}
      reload={reload}
    >
      {state.status === 'ready' && state.snapshot.actions.length === 0
        ? <p className={css.panelEmpty}>{t('panel.actionsEmpty')}</p>
        : state.status === 'ready' && state.snapshot.actions.map(action => <ActionCard key={action.id} action={action} />)}
    </PanelShell>
  )
}
