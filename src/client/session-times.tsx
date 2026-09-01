/**
 * Session-view timestamps: show what time each message and tool call ran at
 * in the DSH main session view.
 *
 * Three additive mechanisms (no DSH core changes; everything degrades back
 * to the official look when disabled):
 *
 * 1. Message clocks. The official conversation UI already renders a start
 *    clock on user messages and an end clock with the turn duration on
 *    assistant turn-tails, but hides both until the row is hovered
 *    (`opacity: 0` under the `@media (hover:hover)` rule scoped by the
 *    official `[data-time-hover-root]` rows). When enabled we inject one
 *    stylesheet that forces those labels visible; the selectors are scoped to
 *    the official hover-root attribute plus a class substring, so a DSH class
 *    rename degrades to the official hover behavior instead of breaking.
 * 2. Tool times. Tool rows render no time at all, and the official tool-call
 *    chat node cannot be wrapped (its cell winner must declare the
 *    `tool.call.toolview` child slot, which the official already owns —
 *    re-declaring it throws). Instead we shadow the official `assistant-step`
 *    renderer (the same keyed-shadow pattern dsh-perf uses), which is legal
 *    because that cell declares no child slots, and after each settled step
 *    renders we inject an always-visible "HH:MM:SS · duration" chip into each
 *    tool row of that step. Times come from the conversation snapshot's
 *    tool-call nodes (`callTime` = call start, `time` = result); rows are
 *    located through the official `data-chat-flow-key` / `data-chat-call-id`
 *    anchors, so the mechanism survives class-hash renames and needs no
 *    hashed-class selectors.
 * 3. Turn token counts. Each turn tail (the official `[data-turn-tail]` row
 *    that already carries the turn's end time and speed) gets an appended
 *    "Input X tok · Output Y tok" chip read from the closing assistant step's
 *    usage event (`inputTokens` + `cacheReadTokens` = billed input,
 *    `outputTokens` = output), matched by turn number from the conversation
 *    snapshot's `turn-tail` node.
 */
import { createElement, memo, useEffect, useRef, type ComponentType } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { t } from './locales.ts'
import css from './session-times.module.css'

/**
 * Stylesheet forcing the official message clocks visible. The official rule
 * hides them with `opacity: 0` under `@media (hover:hover)`; ours matches the
 * same hover-root attribute plus a class substring so it survives class-hash
 * renames, and `!important` wins regardless of stylesheet order.
 */
export const MESSAGE_CLOCK_OVERRIDE_CSS = [
  '[data-time-hover-root] :is([class*="timeStart"], [class*="timeEnd"]) {',
  '  opacity: 1 !important;',
  '}',
].join('\n')

/** Marker on the injected override style tag (idempotent inject/remove). */
const STYLE_TAG_KEY = 'data-dsh-session-time-override'

/** The `conversation.chat.node` key the official assistant renderer uses. */
const ASSISTANT_CELL_KEY = 'assistant-step'

/**
 * Priority headroom under the cell's lowest existing entry; keeps the shadow
 * the "lowest renders" winner while leaving room for third-party renderers
 * that hard-code low priorities (mirrors dsh-perf's shadow strategy).
 */
const SHADOW_PRIORITY_HEADROOM = 8

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Compact local timestamp with seconds: `HH:MM:SS` today, `M/D HH:MM:SS`
 * earlier this year, `Y/M/D HH:MM:SS` other years (24-hour, zero-padded).
 * @param time - Unix epoch ms from the source session event.
 * @param now - Reference instant for the day/year cut (defaults to wall clock).
 * @returns the date-aware clock string.
 */
export function formatSessionClock(time: number, now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${clock}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${clock}`
}

/**
 * Compact duration label: `3.2s` under a minute, `1m 05s`, `1h 02m 03s`.
 * @param ms - Elapsed milliseconds.
 * @returns the label, or an empty string for a non-finite/negative input.
 */
export function formatSessionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Narrow a root ToolCallBlock to its settled form (the union is discriminated by `'kind' in block`). */
function isSettledToolBlock(root: ToolCallBlock): root is Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return 'kind' in root && root.kind === 'tool-result'
}

/** Read the tool call's start time (epoch ms), or undefined when unknown. */
export function toolCallStartTime(root: ToolCallBlock | undefined): number | undefined {
  if (root === undefined) return undefined
  if (isSettledToolBlock(root) && root.callTime !== null) return root.callTime
  return root.time
}

/** Read the settled tool's duration (ms), or undefined while running/unpaired. */
export function toolCallDurationMs(root: ToolCallBlock | undefined): number | undefined {
  if (root === undefined || !isSettledToolBlock(root)) return undefined
  const start = root.callTime
  if (start === null) return undefined
  const end = root.time
  return end >= start ? end - start : undefined
}

/** One tool-call chat node as the injection lookup needs it (structural). */
export interface ToolTimeNodeLike {
  kind?: string
  data?: { root?: ToolCallBlock }
}

/** The chat node store face the injection lookup consumes (structural). */
export interface ToolNodeStoreLike {
  values(): readonly ToolTimeNodeLike[]
}

/** The per-request usage object carried by the assistant usage event. */
export interface TokenUsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Minimal conversation snapshot face used by the injection lookup. */
export interface ConversationSnapshotLike {
  chat?: { nodes?: ToolNodeStoreLike }
}

/**
 * Find the root ToolCallBlock for a call id in the chat node store, or
 * undefined when the call is out of window or the store is absent.
 */
export function findToolBlock(
  nodes: ToolNodeStoreLike | undefined,
  callId: string,
): ToolCallBlock | undefined {
  if (nodes === undefined) return undefined
  for (const node of nodes.values()) {
    if (node?.kind === 'tool-call' && node.data?.root?.callId === callId) return node.data.root
  }
  return undefined
}

/**
 * Compact token count: `999`, `1K`, `15.4K`, `1.2M` (same algorithm the
 * official stats line uses).
 * @param n - token count.
 * @returns the compact label.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Billed input tokens: fresh input plus cache reads and writes (the same
 * aggregation the official session stats line uses).
 * @param usage - the usage object.
 * @returns the billed input count.
 */
export function billedInputTokens(usage: TokenUsageLike | undefined): number {
  if (usage === undefined) return 0
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Find the closing assistant step's usage for one turn in the chat node
 * store, or undefined when the turn tail is out of window or the store is
 * absent.
 */
export function turnTailUsage(
  nodes: ToolNodeStoreLike | undefined,
  turn: number,
): TokenUsageLike | undefined {
  if (nodes === undefined) return undefined
  for (const node of nodes.values()) {
    const data = node?.data as { turn?: unknown; closing?: { usage?: unknown } } | undefined
    if (node?.kind === 'turn-tail' && data?.turn === turn) {
      const usage = data.closing?.usage
      if (typeof usage === 'object' && usage !== null) return usage as TokenUsageLike
    }
  }
  return undefined
}

/**
 * Inject a "Input X tok · Output Y tok" chip into one turn tail row if it
 * lacks one. The chip is appended to the tail's actions row (the official
 * row that already carries the end time and speed labels).
 * @param root - the DOM subtree to scan (the conversation flow).
 * @param turn - the turn number (matches the official `data-turn-tail` value).
 * @param usage - the turn's closing usage, or undefined to skip.
 * @returns whether a chip was injected.
 */
export function injectTurnTokenChip(
  root: ParentNode,
  turn: number,
  usage: TokenUsageLike | undefined,
): boolean {
  const tail = root.querySelector(`[data-turn-tail="${turn}"]`)
  if (tail === null || tail.querySelector('[data-dsh-part="session-tokens"]') !== null) return false
  const input = billedInputTokens(usage)
  const output = usage?.outputTokens ?? 0
  if (input <= 0 && output <= 0) return false
  const chip = document.createElement('span')
  chip.setAttribute('data-dsh-part', 'session-tokens')
  chip.className = css.tokenChip
  chip.textContent = t('session.tokens', { input: formatTokens(input), output: formatTokens(output) })
  const actions = tail.lastElementChild
  ;(actions ?? tail).appendChild(chip)
  return true
}

/**
 * Inject a time chip into every tool-call row under `root` that lacks one.
 * Rows are located by the official `data-chat-call-id` anchor; the chip is
 * prepended to the row's `data-disclosure-row` title bar (or the row itself
 * when that bar is absent). Idempotent: rows already carrying a
 * `data-dsh-part="session-time"` chip are skipped, so re-renders never
 * duplicate chips.
 * @param root - the DOM subtree to scan (the conversation flow).
 * @param nodes - the chat node store used for the time lookup.
 * @returns the number of chips injected.
 */
export function injectToolTimeChips(root: ParentNode, nodes: ToolNodeStoreLike | undefined): number {
  let injected = 0
  for (const row of root.querySelectorAll('[data-chat-call-id]')) {
    if (row.querySelector('[data-dsh-part="session-time"]') !== null) continue
    const callId = row.getAttribute('data-chat-call-id')
    const start = callId === null ? undefined : toolCallStartTime(findToolBlock(nodes, callId))
    if (start === undefined) continue
    const duration = callId === null ? undefined : toolCallDurationMs(findToolBlock(nodes, callId))
    const chip = document.createElement('span')
    chip.setAttribute('data-dsh-part', 'session-time')
    chip.className = css.toolTimeChip
    chip.textContent = duration === undefined
      ? formatSessionClock(start)
      : `${formatSessionClock(start)} · ${formatSessionDuration(duration)}`
    const titleRow = row.querySelector('[data-disclosure-row]')
    if (titleRow !== null) titleRow.prepend(chip)
    else row.prepend(chip)
    injected += 1
  }
  return injected
}

/**
 * Narrow owner shape of the `conversation.chat.node` assistant-step cell: the
 * keyed renderer receives the whole Chat node plus the session standard kit
 * (`useSession`). Kept structural (like dsh-perf's shadow owner) so this
 * module needs no conversation-package type dependency.
 */
export interface AssistantTimeOwner {
  node?: {
    key?: string
    kind?: string
    data?: {
      status?: string
      turn?: number
      usage?: TokenUsageLike
    }
  }
  /** Session-scope standard-kit selector hook bound by the slot dispatcher. */
  useSession?: <T>(selector: (snapshot: unknown) => T) => T
  [key: string]: unknown
}

/**
 * Build the assistant-step shadow around the official renderer: when enabled
 * it renders the official step untouched, then injects a time chip into every
 * tool row of the conversation flow (see injectToolTimeChips); when disabled
 * it forwards to the official renderer with zero extra DOM, so the official
 * look is untouched. Tool rows render as their own flow items beside the
 * step, so the scan is scoped to the conversation scrollport rather than the
 * step's own subtree; each row carries its call id, which is matched against
 * the chat node store for the timestamps.
 * @param official - the official renderer captured at registration time
 * (possibly undefined if it registers after this module's apply runs).
 * @param enabled - live settings reader; false bypasses injection entirely.
 * @param capture - render-time lazy capture of the official renderer (must
 * exclude this shadow by identity).
 * @returns the shadow component.
 */
export function makeAssistantTimeShadow(
  official: ComponentType<AssistantTimeOwner> | undefined,
  enabled: () => boolean,
  capture?: () => ComponentType<AssistantTimeOwner> | undefined,
): ComponentType<AssistantTimeOwner> {
  const Shadow = memo(function AssistantTimeShadow(props: AssistantTimeOwner) {
    const officialRef = useRef<ComponentType<AssistantTimeOwner> | undefined>(official)
    if (officialRef.current === undefined && capture !== undefined) {
      officialRef.current = capture()
    }
    const nodes = props.useSession === undefined
      ? undefined
      : props.useSession((snapshot) => (snapshot as ConversationSnapshotLike)?.chat?.nodes)
    useEffect(() => {
      if (!enabled()) return
      if (props.node?.data?.status !== 'settled') return
      const root = document.querySelector('[data-conversation-scroll]') ?? document
      injectToolTimeChips(root, nodes)
      const turn = props.node?.data?.turn
      if (turn !== undefined) {
        const usage = turnTailUsage(nodes, turn) ?? props.node?.data?.usage
        injectTurnTokenChip(root, turn, usage)
      }
    })
    if (officialRef.current === undefined) return null
    return createElement(officialRef.current, props)
  })
  return Shadow
}

/** Loose slots-service face the registration needs (see registerAssistantTimeShadow). */
export interface SessionTimesSlots {
  /** Register a slot-inject factory; returns the inject disposer. */
  inject(slot: string, factory: () => () => void): () => void
  /** Bound register (must be invoked with the service as `this`). */
  register: (...args: unknown[]) => () => void
  /** Live entries of one slot (used for the priority floor and lazy capture). */
  entries?: (slot: string) => readonly {
    component?: unknown
    options?: { key?: string; priority?: number }
  }[]
}

/**
 * Shadow the official `assistant-step` chat-node renderer so every settled
 * step's tool rows get an always-visible "HH:MM:SS · duration" chip (see
 * makeAssistantTimeShadow). The official renderer is captured lazily on first
 * render and forwarded to with the exact props it would have received, so the
 * official message is untouched. Unlike the tool-call cell, the assistant-step
 * cell declares no child slots, so a shadow entry is legal; the injected
 * `hostDescription`-style faces are unnecessary because the official reads
 * only the slot's own inject and the standard kit.
 * @param slots - the client slots service (`ctx.get('slots')`).
 * @param enabled - live settings reader; false forwards with zero extra DOM.
 * @returns the inject disposer (the fiber unload path removes the shadow).
 */
export function registerAssistantTimeShadow(
  slots: SessionTimesSlots,
  enabled: () => boolean,
): () => void {
  return slots.inject('conversation.chat.node', () => {
    try {
      const existing = (slots.entries?.('conversation.chat.node') ?? [])
        .filter(entry => entry?.options?.key === ASSISTANT_CELL_KEY)
        .map(entry => Number(entry?.options?.priority ?? 0))
      const floor = (existing.length === 0 ? 0 : Math.min(...existing)) - 1 - SHADOW_PRIORITY_HEADROOM
      const shadow = makeAssistantTimeShadow(undefined, enabled, () => {
        for (const entry of slots.entries?.('conversation.chat.node') ?? []) {
          if (entry?.options?.key === ASSISTANT_CELL_KEY && entry.component != null && entry.component !== shadow) {
            return entry.component as ComponentType<AssistantTimeOwner>
          }
        }
        return undefined
      })
      // Type-erased registration: the official slot map lives in the
      // conversation package (not a dependency here), so the same options
      // shape the official assistant-step registration uses is passed through.
      const register = slots.register as unknown as (options: Record<string, unknown>, component: unknown) => () => void
      const unregister = register.call(slots, {
        name: 'conversation.chat.node',
        key: ASSISTANT_CELL_KEY,
        priority: floor,
        locale: 'all-tasks',
      }, shadow)
      return () => { unregister() }
    } catch (error) {
      console.warn('[dsh-all-tasks] session-time assistant shadow registration failed:', error)
      return () => {}
    }
  })
}

/** Idempotently inject the message-clock override stylesheet. */
export function showMessageClocks(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_TAG_KEY}]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_TAG_KEY, '')
  tag.textContent = MESSAGE_CLOCK_OVERRIDE_CSS
  document.head.appendChild(tag)
}

/** Remove the message-clock override stylesheet (restores official hover). */
export function hideMessageClocks(): void {
  if (typeof document === 'undefined') return
  for (const tag of document.querySelectorAll(`style[${STYLE_TAG_KEY}]`)) {
    tag.remove()
  }
}
