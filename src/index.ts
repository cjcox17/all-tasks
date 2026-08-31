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
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { normalizeEndpointsConfig, type EndpointRouterConfig } from './core/endpoints.ts'
import { TaskBoardHostService } from './host-service.ts'
import { makeTaskBoardRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Default environment variable holding the authenticated proxy token. */
export const DEFAULT_PROXY_TOKEN_ENV = 'DSH_TASK_BOARD_PROXY_TOKEN'

export const inject = ['systemPrompt', 'apiProxy', 'webServer', 'agents', 'commands']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASK_BOARD_GUIDANCE = '本机已安装 all-tasks 插件（DSH Web GUI 的任务看板）：侧边栏「全部任务」入口；独立仓库 cjcox17/all-tasks 维护（源自 zhu1090093659/dsh-web 的 dsh-task-board）。能力：多列看板管理任务；Host 权威账本；关闭浏览器后仍由 Host 执行和结算；任务可钉住工作区、agent 预设、模型和权限；任务可归入分组（顺序/并行、组内端点与窗口、组定时，组定时启用时组内任务继承它而忽略各自定时）；支持 Host 本地时区的 5 段 cron，错过的触发点不补跑；可选且默认关闭的空闲系统睡眠保护允许屏幕熄灭，但不承诺拦截合盖、手动睡眠、休眠、关机或唤醒已睡眠机器。执行消耗 API 额度。用户提到「全部任务 / 看板 / 定时任务 / 分组」时即指本插件，请据此协作。若你同时用 todo_write 维护会话顶部的可见计划列表，最终回复前必须再次调用 todo_write 收尾：没有剩余工作时不要保留 in_progress，已完成的最后一步要标为 completed。'

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
  /** Global off-peak window (DeepSeek 16:30–00:30 UTC by default). */
  offPeak?: OffPeakWindowConfig
  /** How long a queued run may wait for an eligible endpoint before failing (hours). */
  endpointMaxWaitHours?: number
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints?: string[]
  /** Named compute endpoints the router routes tasks through. */
  endpoints?: EndpointSettingsConfig[]
}

/** A daily clock window (24h 'HH:MM'; start > end crosses midnight). */
export interface DailyWindowConfig {
  start: string
  end: string
}

/** An off-peak window with an optional IANA time zone (UTC by default). */
export interface OffPeakWindowConfig extends DailyWindowConfig {
  timezone?: string
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
  /** Max concurrent launched executions through this endpoint. */
  maxConcurrency?: number
  /** Router token cap; a model whose DSH maxTokens exceeds it is ineligible. */
  maxTokens?: number
  /** Daily hours (host-local) the endpoint may be used; absent = always. */
  allowedHours?: DailyWindowConfig
  /** Only run inside the (global or per-endpoint) off-peak window. */
  offPeakOnly?: boolean
  /** Per-endpoint off-peak window override. */
  offPeak?: OffPeakWindowConfig
}

const dailyWindow = z.object({
  start: z.string().default(''),
  end: z.string().default(''),
})

const offPeakWindow = z.object({
  start: z.string().default('16:30'),
  end: z.string().default('00:30'),
  timezone: z.string().default('UTC'),
})

const endpointSettings = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  provider: z.string().min(1),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().default(''),
  maxConcurrency: z.number().min(1).default(1),
  maxTokens: z.number().min(0).default(0),
  allowedHours: dailyWindow.default({ start: '', end: '' }),
  offPeakOnly: z.boolean().default(false),
  offPeak: offPeakWindow.default({ start: '16:30', end: '00:30', timezone: 'UTC' }),
})

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(false),
  enabled: z.boolean().default(true),
  preventIdleSleep: z.boolean().default(false),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
  offPeak: offPeakWindow.default({ start: '16:30', end: '00:30', timezone: 'UTC' }),
  endpointMaxWaitHours: z.number().min(0).default(24),
  defaultEndpoints: z.array(z.string()).default([]),
  endpoints: z.array(endpointSettings).default([]),
})

/** Build the normalized Host router config from the resolved plugin settings. */
export function routerConfigFromSettings(config: Config | undefined): EndpointRouterConfig {
  return normalizeEndpointsConfig(config ?? {})
}

/**
 * Best-effort read of DSH's per-model `maxTokens` from the `llm-pi-ai` settings
 * namespace (the Models section). The router compares it against each
 * endpoint's token cap; when the namespace is absent the check is skipped.
 */
export function readPiAiModelMaxTokens(ctx: Context, provider: string, model: string): number | undefined {
  try {
    const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
    const pi = settings?.get?.('llm-pi-ai') as
      | { providers?: Record<string, { maxTokens?: unknown; models?: Array<{ id?: unknown; maxTokens?: unknown }> }> }
      | undefined
    const providerConfig = pi?.providers?.[provider]
    const modelConfig = providerConfig?.models?.find(entry => entry.id === model)
    const value = modelConfig?.maxTokens ?? providerConfig?.maxTokens
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
  } catch {
    return undefined
  }
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
    readModelMaxTokens: (provider, model) => readPiAiModelMaxTokens(ctx, provider, model),
  })
  host.setConfiguration(config?.enabled ?? true, config?.preventIdleSleep ?? false)
  host.start()
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeTaskBoardRoutes(host, resolveProxyAccess(config))) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
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
