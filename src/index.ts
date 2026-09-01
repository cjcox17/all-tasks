/**
 * Host loader entry for the task-board plugin.
 *
 * The Host owns the v2 ledger, action API, cron scheduler, session runner,
 * execution reconciliation, and optional idle-sleep inhibitor. The browser is
 * a same-origin asynchronous view over that service.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ActionDispatcher } from './action-dispatcher.ts'
import { createHttpAction, type HttpActionConfig } from './action-http.ts'
import { ActionRegistry } from './core/actions.ts'
import { normalizeEndpointsConfig, type EndpointRouterConfig } from './core/endpoints.ts'
import { EventSourceRegistry } from './core/events.ts'
import { createGithubEventSource, type GithubEventConfig } from './event-github.ts'
import { createHttpEventSource, type HttpEventConfig } from './event-http.ts'
import { TaskBoardHostService } from './host-service.ts'
import { makeEventRoutes, makeTaskBoardRoutes } from './host-routes.ts'
import type { ModelTimeoutSettingsSeam } from './model-timeouts.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Default environment variable holding the authenticated proxy token. */
export const DEFAULT_PROXY_TOKEN_ENV = 'DSH_TASK_BOARD_PROXY_TOKEN'

export const inject = ['systemPrompt', 'apiProxy', 'webServer', 'agents', 'commands']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASK_BOARD_GUIDANCE = '本机已安装 all-tasks 插件（DSH Web GUI 的任务看板）：侧边栏「全部任务」入口；独立仓库 cjcox17/all-tasks 维护（源自 zhu1090093659/dsh-web 的 dsh-task-board）。能力：多列看板管理任务；打开看板先见工作区总览网格（每个工作区的实时任务计数，点击进入该工作区看板，头部返回按钮回到总览）；Host 权威账本；关闭浏览器后仍由 Host 执行和结算；每个工作区可设置默认执行参数（agent 预设、模型、端点、权限、是否默认未批准），新建任务时自动预填，且任务自身未设置的执行参数在执行时回退到其工作区的默认值；任务可钉住工作区、agent 预设、模型和权限；任务可归入分组（顺序/并行、组内端点与窗口、组定时，组定时启用时组内任务继承它而忽略各自定时）；支持 Host 本地时区的 5 段 cron，错过的触发点不补跑；可选且默认关闭的空闲系统睡眠保护允许屏幕熄灭，但不承诺拦截合盖、手动睡眠、休眠、关机或唤醒已睡眠机器。执行消耗 API 额度。用户提到「全部任务 / 看板 / 工作区 / 定时任务 / 分组」时即指本插件，请据此协作。若你同时用 todo_write 维护会话顶部的可见计划列表，最终回复前必须再次调用 todo_write 收尾：没有剩余工作时不要保留 in_progress，已完成的最后一步要标为 completed。'

/**
 * Settings namespace of the board's announcement capability — the section the
 * web settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const TASK_BOARD_SETTINGS_NAMESPACE = settingsNamespace('task-board')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /**
   * When true (default), a system-prompt section announces the board to every
   * agent. Set false to keep the board silent in prompts; agents then learn
   * about it only when the user mentions it.
   */
  announceToAgent?: boolean
  /** Master switch for the plugin (browser half + host announcement). */
  enabled?: boolean
  /** Prevent idle system sleep while sessions run or schedules are armed. */
  preventIdleSleep?: boolean
  /** Canonical reverse-proxy Host authorities admitted with a server-side token. */
  trustedProxyHosts?: string[]
  /** Environment variable whose value the authenticated proxy injects upstream. */
  proxyTokenEnv?: string
  /** How long a queued run may wait for an eligible endpoint before failing (hours). */
  endpointMaxWaitHours?: number
  /** Cost estimate: USD per 1M input tokens (0 = not configured). */
  costPerMillionInputTokens?: number
  /** Cost estimate: USD per 1M output tokens (0 = not configured). */
  costPerMillionOutputTokens?: number
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints?: string[]
  /** Named compute endpoints the router routes tasks through. */
  endpoints?: EndpointSettingsConfig[]
  /** Inbound event source plugins (webhook → task). */
  events?: { http?: HttpEventConfig; github?: GithubEventConfig }
  /** Result-side action plugins (settle → side effect). */
  actions?: { http?: HttpActionConfig }
}

/** One named compute endpoint (a backend serving one DSH provider route). */
export interface EndpointSettingsConfig {
  /** Stable endpoint id (referenced by tasks and the default list). */
  id: string
  /** Display name (DeepSeek Official, LM Studio on the NAS, …). */
  name?: string
  /** DSH provider route id (an `llm.models` group id) this endpoint serves. */
  provider: string
  /** Model ids this endpoint serves; empty means all models of the provider. */
  models?: string[]
  /** Model used when the task's model pin cannot be served by this endpoint. */
  defaultModel?: string
}

const endpointSettings = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  provider: z.string().min(1),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().default(''),
})

const httpEventSettings = z.object({
  tokenEnv: z.string().default(''),
  workspaceId: z.string().default(''),
  autoRun: z.boolean().default(false),
})

const githubEventSettings = z.object({
  secretEnv: z.string().default(''),
  repoWorkspaces: z.dict(z.string()).default({}),
  defaultWorkspaceId: z.string().default(''),
  autoRun: z.boolean().default(false),
})

const httpActionSettings = z.object({
  url: z.string().default(''),
  tokenEnv: z.string().default(''),
})

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(false),
  enabled: z.boolean().default(true),
  preventIdleSleep: z.boolean().default(false),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
  endpointMaxWaitHours: z.number().min(0).default(24),
  costPerMillionInputTokens: z.number().min(0).default(0),
  costPerMillionOutputTokens: z.number().min(0).default(0),
  defaultEndpoints: z.array(z.string()).default([]),
  endpoints: z.array(endpointSettings).default([]),
  events: z.object({ http: httpEventSettings, github: githubEventSettings }).default({ http: { tokenEnv: '', workspaceId: '', autoRun: false }, github: { secretEnv: '', repoWorkspaces: {}, defaultWorkspaceId: '', autoRun: false } }),
  actions: z.object({ http: httpActionSettings }).default({ http: { url: '', tokenEnv: '' } }),
})

/** Build the normalized Host router config from the resolved plugin settings. */
export function routerConfigFromSettings(config: Config | undefined): EndpointRouterConfig {
  return normalizeEndpointsConfig(config ?? {})
}

/** Resolve proxy access without ever placing the token value in plugin config. */
export function resolveProxyAccess(config: Config | undefined, env: NodeJS.ProcessEnv = process.env): { trustedProxyHosts: string[]; proxyToken?: string } {
  const trustedProxyHosts = config?.trustedProxyHosts ?? []
  if (trustedProxyHosts.length === 0) return { trustedProxyHosts }
  const proxyTokenEnv = config?.proxyTokenEnv ?? DEFAULT_PROXY_TOKEN_ENV
  if (proxyTokenEnv.trim() === '') throw new Error('task-board: proxyTokenEnv must not be empty')
  const proxyToken = env[proxyTokenEnv]
  if (proxyToken === undefined || proxyToken === '') {
    throw new Error(`task-board: trustedProxyHosts requires a non-empty ${proxyTokenEnv} environment variable`)
  }
  return { trustedProxyHosts, proxyToken }
}

/** Schema default, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false

/**
 * Build the narrow settings seam the model-timeout editor needs. Resolved at
 * call time so it starts working the moment the settings service is up even
 * when the plugin applies earlier; absent service yields an undefined seam,
 * which disables the editor routes rather than crashing them.
 */
function modelTimeoutSettingsSeam(ctx: Context): ModelTimeoutSettingsSeam | undefined {
  return {
    get: (ns) => (ctx.get('settings') as { get?: (ns: string) => unknown } | undefined)?.get?.(ns),
    mutate: async (ns, ops, expectedRevision) => {
      const service = ctx.get('settings') as { mutate?: (ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number) => Promise<void> } | undefined
      if (service?.mutate === undefined) throw new Error('settings service is unavailable')
      await service.mutate(ns, ops, expectedRevision)
    },
  }
}

/**
 * Register the board's announcement section, gated on the composition entry's
 * `announceToAgent` (and the live settings value once the web settings
 * surface is served). The section is re-registered whenever the source
 * changes, so a settings edit takes effect without a restart.
 * @param ctx - the plugin context (systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('@linxin666/dsh-client-ui-all-tasks', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const host = new TaskBoardHostService(ctx.apiProxy, {
    commandDispatcher: {
      async execute(sessionId, line, signal) {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error(`execution session ${sessionId} is not available`)
        return (await ctx.commands.execute(agent, line, [], signal))?.result
      },
    },
    settings: modelTimeoutSettingsSeam(ctx),
  })
  host.setConfiguration(config?.enabled ?? true, config?.preventIdleSleep ?? false)
  host.start()
  const eventSources = new EventSourceRegistry()
  eventSources.register(createHttpEventSource(config?.events?.http))
  eventSources.register(createGithubEventSource(config?.events?.github))
  const actions = new ActionRegistry()
  actions.register(createHttpAction())
  const dispatcher = new ActionDispatcher(host.ledger, actions, {
    get: (id) => (config?.actions as Record<string, unknown> | undefined)?.[id],
  })
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeTaskBoardRoutes(host, resolveProxyAccess(config))) disposers.push(ctx.webServer.register(route))
      for (const route of makeEventRoutes(eventSources, host, resolveProxyAccess(config))) disposers.push(ctx.webServer.register(route))
      dispatcher.start()
    } catch (error) {
      for (const dispose of disposers) dispose()
      dispatcher.stop()
      host.dispose()
      throw error
    }
    return () => {
      dispatcher.stop()
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'task-board: host ledger, scheduler, and routes')
  // The live source the announcement reads: the settings section once the web
  // settings surface is served, the composition entry otherwise
  // (installSettingsSection swaps it when the namespace registers).
  let current: () => Config = () => config ?? {}
  let disposeSection: (() => void) | undefined

  // Register (or drop) the announcement to match the current source. The
  // section is kept under one disposer: re-registering first tears the old
  // one down so a duplicate-name registration never throws.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const active = current().enabled ?? true
    host.setConfiguration(active, current().preventIdleSleep ?? false)
    host.setEndpointConfig(routerConfigFromSettings(current()))
    if (!active) return
    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:task-board',
      order: SECTION_ORDER,
      text: TASK_BOARD_GUIDANCE,
    })
  }

  installSettingsSection(ctx, TASK_BOARD_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
