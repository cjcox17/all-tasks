/**
 * All-tasks client plugin: wires the framework-free core (controller,
 * execution service, store) to the real client runtime and mounts the two
 * DOM surfaces — the sidebar entry row and the board view in the center
 * column.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { ClientContext, ISessions, IWorkspaces, SessionId, SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the official `settings.plugin.item` slot declaration (the
// configurable-plugins tab pairs served namespaces with cards registered
// under this keyed slot; the card's PropsRuntime types against it). The
// client entry re-exports the slot contract, loading its SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { BoardController } from '../core/controller.ts'
import { LocalStorageTaskStore } from '../core/store.ts'
import { claimAllTasksApply, releaseAllTasksApply } from './apply-guard.ts'
import { mountBoard } from './board-mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { AllTasksSettingsCard, AllTasksSettingsCardController, type AllTasksSettings } from './AllTasksSettingsCard.tsx'
import { en, zh, type AllTasksKey } from './locales.ts'
import { HttpAllTasksHostTransport } from './host-api.ts'
import { hideMessageClocks, registerAssistantTimeShadow, showMessageClocks, type SessionTimesSlots } from './session-times.tsx'
import { reportDailyHeartbeat } from './telemetry.ts'

/** Locale namespace this plugin owns. */
const NS = 'all-tasks'

/** Settings namespace the settings card edits (the Host plugin registers it). */
const ALL_TASKS_NS = 'all-tasks'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** All-tasks surface copy. */
    'all-tasks': AllTasksKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional rc.6 compatibility binder provided by dsh-web-settings;
     * absent when that group plugin is not installed, so callers fall back to
     * the official settings scope.
     */
    webUiSettings?: { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> }
  }
}


/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'sessions', 'workspaces', 'connection', 'settingsScope', 'locale', 'remote']

/**
 * Mount the task board.
 * @param ctx - client root context (services: sessions, workspaces).
 */
export function apply(ctx: ClientContext): void {
  // Anonymous install heartbeat (docs/telemetry.md): one beat per browser per
  // UTC day, package name only, silent failure.
  reportDailyHeartbeat([{ name: '@cjcox17/all-tasks' }])

  // A duplicated client injection (module factory executed twice in one page
  // lifetime) would otherwise mount a second sidebar entry and board view.
  // First application wins; later calls become no-ops (see apply-guard.ts).
  if (!claimAllTasksApply()) return

  // Release the claim when this fiber unloads (the loader supports plugin
  // unloads / hot-reloads), so a rebuilt bundle can claim again in the same
  // page instead of being silently dropped.
  ctx.effect(() => releaseAllTasksApply, 'all-tasks: apply claim')

  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'all-tasks: dictionaries')

  // Plugin configuration card: one staged form over the `all-tasks` settings
  // namespace, contributed to the official Plugins section's configurable tab
  // (`settings.plugin.item`, keyed by the namespace it edits). The earlier
  // `web-ui.plugin.item` slot belonged to a dsh-web-only group that the
  // standalone DSH distribution does not compose, so the card never rendered.
  const binder = ctx.get('webUiSettings') ?? ctx.settingsScope
  const settingsScope = binder.bind<AllTasksSettings>({ namespace: ALL_TASKS_NS })
  const settingsCard = new AllTasksSettingsCardController(settingsScope)
  ctx.slots.inject('settings.plugin.item', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'settings.plugin.item',
        key: ALL_TASKS_NS,
        locale: NS,
        inject: () => settingsCard.inject(),
      }, AllTasksSettingsCard)
      return () => {
        settingsCard.dispose()
        unregister()
      }
    } catch {
      return () => {}
    }
  })

  // Session-view timestamps and token counts (see session-times.tsx): show
  // what time each message and tool call ran at and how many tokens each
  // turn used, in the main session view. Independent of the board UI (it
  // decorates the official chat flow), so it mounts with the plugin, gated by
  // its own `sessionTimestamps` setting (default on).
  const sessionTimestampsEnabled = (): boolean => {
    const snapshot = settingsScope.getSnapshot()
    return snapshot.status === 'ready' ? (snapshot.value?.sessionTimestamps ?? true) : true
  }
  const syncSessionTimeStyles = (): void => {
    try {
      if (sessionTimestampsEnabled()) showMessageClocks()
      else hideMessageClocks()
    } catch {
      // Cosmetic only: a failure leaves the official hover-reveal behavior.
    }
  }
  ctx.effect(() => {
    syncSessionTimeStyles()
    return settingsScope.subscribe(syncSessionTimeStyles)
  }, 'all-tasks: session-time styles')
  ctx.effect(() => registerAssistantTimeShadow(ctx.slots as unknown as SessionTimesSlots, sessionTimestampsEnabled), 'all-tasks: session-time assistant shadow')

  // The sidebar entry and board view mount once the settings scope settles;
  // while the scope is still loading, the composition default is unknown, so
  // nothing mounts yet. Only an unavailable scope (no settings surface served)
  // falls back to the composition default (enabled).
  let uiDisposer: (() => void) | undefined
  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    // Host and browser SDK declarations share the Cordis Context name. Read
    // the browser faces explicitly so Host-side declaration merging cannot
    // narrow these two client services during a combined package build.
    const sessions = ctx.get('sessions') as unknown as ISessions
    const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
    const connection = ctx.get('connection') as ConnectionHandle

    // Core wiring: real runtime faces into the framework-free services.
    const store = new LocalStorageTaskStore()
    const controller = new BoardController({
      store,
      transport: new HttpAllTasksHostTransport(),
      sessions: {
        list: sessions.list,
        open: id => sessions.open(id as SessionId),
      },
    })
    controller.start()

    const disposers: Array<() => void> = []

    // Execution-target option feeds: the workspace list drives the workspace
    // picker, the agent-preset roster drives the mode picker, and the host
    // model catalog drives the model picker. All three are runtime facts (not
    // ledger state), so the wiring pushes them into the controller on change;
    // the roster and catalog are re-read after reconnects because a reconnect
    // may serve a different deployment.
    const pushWorkspaceOptions = (): void => {
      const snapshot = workspaces.list.getSnapshot()
      controller.setExecutionOptions({
        workspaces: snapshot.items.map(item => ({
          workspaceId: item.workspaceId,
          title: item.title !== '' ? item.title : item.path,
        })),
      })
    }
    pushWorkspaceOptions()
    disposers.push(workspaces.list.subscribe(pushWorkspaceOptions))
    const pushPresetOptions = async (): Promise<void> => {
      try {
        const response = await connection.api.agentPresets.list({})
        if (!response.result.ok) return
        controller.setExecutionOptions({
          presets: response.result.value.presets.map(preset => ({
            id: preset.id,
            name: preset.name,
            description: preset.description,
            broken: preset.broken,
            isDefault: preset.isDefault,
          })),
        })
      } catch (error) {
        // A failed roster read leaves the previous options in place; the
        // picker stays usable and the next reconnect retries the read.
        console.error('[dsh-all-tasks] agent preset roster read failed', error)
      }
    }
    // Endpoint options come from the plugin's own settings (the `all-tasks`
    // namespace the Host validates and the router enforces), not the runtime.
    // The provider/model facts ride along so the model picker can constrain
    // itself to models the pinned endpoints actually serve.
    const pushEndpointOptions = (): void => {
      const settings = settingsScope.getSnapshot()
      controller.setExecutionOptions({
        endpoints: settings.status === 'ready'
          ? (settings.value?.endpoints ?? []).map(endpoint => ({
              id: endpoint.id,
              name: endpoint.name ?? endpoint.id,
              provider: endpoint.provider,
              models: endpoint.models,
              defaultModel: endpoint.defaultModel,
            }))
          : [],
      })
    }
    pushEndpointOptions()
    disposers.push(settingsScope.subscribe(pushEndpointOptions))
    // Per-token pricing for the dashboard cost estimate (0 = not configured).
    const pushPricing = (): void => {
      const settings = settingsScope.getSnapshot()
      const input = settings.status === 'ready' ? settings.value?.costPerMillionInputTokens : undefined
      const output = settings.status === 'ready' ? settings.value?.costPerMillionOutputTokens : undefined
      controller.setPricing(
        typeof input === 'number' && input > 0 && typeof output === 'number' && output > 0
          ? { inputPerMillion: input, outputPerMillion: output }
          : undefined,
      )
    }
    pushPricing()
    disposers.push(settingsScope.subscribe(pushPricing))
    // Dashboard usage window in hours (0 = all time): narrows the token totals
    // and the cost estimate to executions settled within the last N hours.
    const pushUsageRetention = (): void => {
      const settings = settingsScope.getSnapshot()
      const hours = settings.status === 'ready' ? settings.value?.usageRetentionHours : undefined
      controller.setUsageRetentionHours(typeof hours === 'number' && hours > 0 ? hours : undefined)
    }
    pushUsageRetention()
    disposers.push(settingsScope.subscribe(pushUsageRetention))
    // Auto-title generation for the new-task dialog (default on): a blank
    // title is generated from the run prompt through a backend session; the
    // prompt-line fallback still applies at submit when the setting is off.
    const pushAutoTitle = (): void => {
      const settings = settingsScope.getSnapshot()
      controller.setAutoTitle(settings.status !== 'ready' || (settings.value?.autoTitle ?? true))
    }
    pushAutoTitle()
    disposers.push(settingsScope.subscribe(pushAutoTitle))
    const pushModelOptions = async (): Promise<void> => {
      try {
        const response = await connection.api.llm.models({})
        if (!response.result.ok) return
        controller.setExecutionOptions({
          models: response.result.value.groups.flatMap(group => group.models.map(model => ({
            provider: group.id,
            providerName: group.name,
            model: model.id,
            modelName: model.name,
          }))),
        })
      } catch (error) {
        // A failed catalog read leaves the previous options in place; the
        // picker stays usable and the next reconnect retries the read.
        console.error('[dsh-all-tasks] model catalog read failed', error)
      }
    }
    void pushPresetOptions()
    void pushModelOptions()
    disposers.push(ctx.on('connection/reset', () => { void pushPresetOptions(); void pushModelOptions() }))
    try {
      disposers.push(mountSidebarEntry(controller))
      disposers.push(mountBoard(controller))
    } catch (error) {
      // DOM failures degrade the board, never the GUI.
      console.error('[dsh-all-tasks] mount failed:', error)
    }

    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      controller.dispose()
      uiDisposer = undefined
    }
  }
  const syncEnabled = (): void => {
    const snapshot = settingsScope.getSnapshot()
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
    else uiDisposer?.()
  }
  settingsScope.subscribe(syncEnabled)
  syncEnabled()
}
