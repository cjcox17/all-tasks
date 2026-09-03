/**
 * Session-row archive buttons: a one-click Archive affordance on every DSH
 * sidebar session row, next to the official "…" menu.
 *
 * The official session list (dsh-client-ui-workspace) renders one row per
 * visible session with a hover-revealed actions span that holds the "…" menu
 * (Rename / Fork / Archive session). There is no per-row action slot an
 * external plugin can register into and the rows carry no session-id DOM
 * attribute, so this module injects a plain DOM button into each row's
 * actions span — left of the "…" — and resolves the row's session id from
 * the row title against the sessions/workspaces runtime state. Clicking it
 * runs the same archive operation as the official "Archive session" menu item
 * (the registry-global archive set: the session disappears from every DSH
 * grouping surface; its log and workspace accounting slot remain).
 *
 * Safety: archiving hides the session, so a wrong guess is costly. The icon
 * is therefore rendered only when the row's session can be identified with
 * certainty:
 *  - exactly one visible session carries the row's title, or
 *  - several sessions share the title, but they all sit in one workspace
 *    section whose rendered rows provably match that workspace's recorded
 *    session order: every row title matches the member title at the same
 *    position and at least one row in the section carries a globally unique
 *    title (the anchor that pins the account order), so each row maps to its
 *    member by position. A section whose titles are all duplicates carries no
 *    anchor and keeps the "…" menu for those rows.
 * Rows that fail both checks (duplicate titles in the flat list, a
 * drag-reordered account, a collapsed/truncated section, an ungrouped
 * section) keep the official "…" menu and never show the icon.
 *
 * Everything is additive and DOM-level (the same strategy as the sidebar
 * entry and the session-view timestamps): a MutationObserver re-injects after
 * every React re-render, idempotently, and disabling the feature removes the
 * injected buttons.
 *
 * The row selectors are official class substrings (hashed prefix + stable
 * suffix, e.g. `…_sessionRow`), exactly like panel-activation.ts and
 * sidebar-entry-core.ts, so a DSH class rename degrades to no injection
 * instead of mis-targeting.
 */
import { archiveIconSvg } from './archive-icon.ts'
import { t } from './locales.ts'
import css from './session-archive.module.css'

/** Idempotency marker on the injected button (row lookup + reconcile key). */
export const SESSION_ARCHIVE_ATTR = 'data-dsh-session-archive'
/** Carries the resolved session id on the injected button (read at click time). */
export const SESSION_ARCHIVE_ID_ATTR = 'data-dsh-session-archive-id'

const SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
const SESSION_ROW_SELECTOR = '[class*="sessionRow"]'
const ROW_ACTIONS_SELECTOR = '[class*="rowActions"]'
const TITLE_SELECTOR = '[class*="title"]'
const SECTION_SELECTOR = '[class*="groupSection"]'
const PROJECT_ROW_SELECTOR = '[class*="projectRow"]'

/** Structural face of one session summary (mirrors the runtime shape). */
export interface SessionArchiveSummaryLike {
  id: string
  /** Human-facing label the sidebar row displays (durable title, project basename, then id). */
  displayTitle?: string
  blank?: boolean
  origin?: string
}

/** Structural face of the sessions.list snapshot this resolver consumes. */
export interface SessionArchiveListLike {
  byId?: Record<string, SessionArchiveSummaryLike>
  current?: string
}

/** Structural face of one workspace (membership + display title). */
export interface SessionArchiveWorkspaceLike {
  workspaceId: string
  title: string
  sessionIds: readonly string[]
}

/** Structural face of the workspaces.list snapshot this resolver consumes. */
export interface SessionArchiveWorkspacesLike {
  items?: readonly SessionArchiveWorkspaceLike[]
  archivedSessionIds?: readonly string[]
}

/** The runtime facts one reconcile pass resolves rows against. */
export interface SessionArchiveState {
  sessions: SessionArchiveListLike
  workspaces: SessionArchiveWorkspacesLike
}

/** Archive callable (the caller owns the real service). */
export type SessionArchiveFn = (sessionId: string) => Promise<unknown>

/** Read the session title the row displays, or undefined when absent. */
export function sessionRowTitle(row: Element): string | undefined {
  const node = row.querySelector<HTMLElement>(TITLE_SELECTOR)
  if (node === null) return undefined
  const text = node.textContent?.trim()
  return text === undefined || text === '' ? undefined : text
}

/** The official visibility rule: subagent and archived sessions never render as rows; only the current blank row does. */
function isVisibleSummary(summary: SessionArchiveSummaryLike, archived: ReadonlySet<string>, current: string | undefined): boolean {
  if (summary.origin === 'subagent') return false
  if (archived.has(summary.id)) return false
  if (summary.blank !== true) return true
  return summary.id === current
}

/** Find the workspace whose section (project row) carries the given title, if any. */
function workspaceOfTitle(title: string, workspaces: readonly SessionArchiveWorkspaceLike[]): SessionArchiveWorkspaceLike | undefined {
  return workspaces.find(workspace => workspace.title === title)
}

/** Read the title of a workspace section's project row (used to map the section to its workspace). */
function sectionWorkspaceTitle(section: Element): string | undefined {
  const row = section.querySelector<HTMLElement>(`${PROJECT_ROW_SELECTOR} ${TITLE_SELECTOR}`)
  if (row === null) return undefined
  const text = row.textContent?.trim()
  return text === undefined || text === '' ? undefined : text
}

/**
 * Resolve the session id a session row displays, or undefined when the row
 * cannot be tied to one session with certainty (see the module doc).
 * @param row - the official `…sessionRow` element.
 * @param sessions - sessions.list snapshot.
 * @param workspaces - workspaces.list snapshot.
 * @returns the resolved session id, or undefined.
 */
export function resolveRowSessionId(
  row: Element,
  sessions: SessionArchiveListLike,
  workspaces: SessionArchiveWorkspacesLike,
): string | undefined {
  const title = sessionRowTitle(row)
  if (title === undefined) return undefined
  const archived = new Set(workspaces.archivedSessionIds ?? [])
  const visible = Object.values(sessions.byId ?? {})
    .filter(summary => isVisibleSummary(summary, archived, sessions.current))
  const named = visible.filter(summary => (summary.displayTitle ?? '') === title)
  if (named.length === 1) return named[0].id
  if (named.length === 0) return undefined

  // Duplicate titles: positional mapping only inside a workspace section
  // whose rendered rows provably match the workspace's recorded session
  // order. Every row's title must match the member title at the same
  // position (a drag-reorder that displaced a differently-named session
  // breaks the match), and at least one row in the section must carry a
  // globally unique title — the anchor that pins the account order. A
  // section where every title repeats carries no signal (identical rows
  // cannot be told apart), so its duplicates keep the "…" menu.
  const section = row.closest(SECTION_SELECTOR)
  if (section === null) return undefined
  const sectionTitle = sectionWorkspaceTitle(section)
  if (sectionTitle === undefined) return undefined
  const workspace = workspaceOfTitle(sectionTitle, workspaces.items ?? [])
  if (workspace === undefined) return undefined
  const byId = sessions.byId ?? {}
  const members = workspace.sessionIds
    .map(id => byId[id])
    .filter((summary): summary is SessionArchiveSummaryLike =>
      summary !== undefined && summary.blank !== true && isVisibleSummary(summary, archived, sessions.current))
  const rows = Array.from(section.querySelectorAll(SESSION_ROW_SELECTOR))
    .filter(candidate => candidate.querySelector(ROW_ACTIONS_SELECTOR) !== null)
  if (rows.length !== members.length) return undefined
  const titleCounts = new Map<string, number>()
  for (const summary of visible) {
    titleCounts.set(summary.displayTitle ?? '', (titleCounts.get(summary.displayTitle ?? '') ?? 0) + 1)
  }
  let anchored = false
  for (let index = 0; index < rows.length; index += 1) {
    const memberTitle = members[index]?.displayTitle ?? ''
    const rowTitle = sessionRowTitle(rows[index])
    if (rowTitle !== memberTitle) return undefined
    if ((titleCounts.get(rowTitle) ?? 0) === 1) anchored = true
  }
  if (!anchored) return undefined
  const index = rows.indexOf(row)
  if (index === -1) return undefined
  return members[index]?.id
}

/**
 * Build the archive icon button for one resolved row.
 * @param sessionId - the resolved session id (read again at click time).
 * @param name - the session title, for the accessible label.
 * @param archive - the archive operation.
 * @returns the detached button.
 */
export function createArchiveButton(sessionId: string, name: string, archive: SessionArchiveFn): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(SESSION_ARCHIVE_ATTR, '')
  button.setAttribute(SESSION_ARCHIVE_ID_ATTR, sessionId)
  button.setAttribute('data-dsh-plugin', 'all-tasks')
  button.setAttribute('data-dsh-part', 'session-archive')
  button.className = css.archiveButton
  button.setAttribute('aria-label', t('session.archiveAria', { name }))
  button.setAttribute('title', t('session.archiveTooltip'))
  // The official DSH `IconArchiveOutline20` drawing, 16 px like the row icons.
  button.innerHTML = archiveIconSvg(16)
  button.addEventListener('click', (event) => {
    // A row click opens the session and the official anchor opens the "…"
    // menu — the icon is its own action, so neither may run.
    event.preventDefault()
    event.stopPropagation()
    const id = button.getAttribute(SESSION_ARCHIVE_ID_ATTR)
    if (id === null) return
    void archive(id).catch((reason: unknown) => {
      // The official menu warns and leaves the row; mirror that.
      console.warn('[dsh-all-tasks] session archive rejected:', reason)
    })
  })
  return button
}

/** Remove the injected archive button from one row (if present). */
export function dropRowIcon(row: Element): boolean {
  const icon = row.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)
  if (icon === null) return false
  icon.remove()
  return true
}

/**
 * One reconcile pass over the sidebar session rows: inject an archive button
 * into every row whose session resolves with certainty, refresh buttons whose
 * resolved id drifted, and remove buttons that no longer resolve (title
 * edits, renames, and rows that lost their actions span).
 * @param root - the DOM subtree to scan (the sidebar shell root).
 * @param state - the live sessions/workspaces facts.
 * @param archive - the archive operation.
 * @param enabled - live feature switch; false removes every injected button.
 * @returns the number of DOM changes made.
 */
export function reconcileSessionArchiveRows(
  root: ParentNode,
  state: SessionArchiveState,
  archive: SessionArchiveFn,
  enabled: () => boolean,
): number {
  if (!enabled()) {
    let removed = 0
    for (const row of Array.from(root.querySelectorAll(SESSION_ROW_SELECTOR))) {
      if (dropRowIcon(row)) removed += 1
    }
    return removed
  }
  let changed = 0
  for (const row of Array.from(root.querySelectorAll(SESSION_ROW_SELECTOR))) {
    // Blank (provisional New Session) rows render no actions span and the
    // official menu never appears there — nothing to decorate.
    const actions = row.querySelector<HTMLElement>(ROW_ACTIONS_SELECTOR)
    const icon = row.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)
    if (actions === null) {
      if (dropRowIcon(row)) changed += 1
      continue
    }
    const sessionId = resolveRowSessionId(row, state.sessions, state.workspaces)
    if (sessionId === undefined) {
      if (dropRowIcon(row)) changed += 1
      continue
    }
    const name = state.sessions.byId?.[sessionId]?.displayTitle ?? sessionRowTitle(row) ?? sessionId
    const label = t('session.archiveAria', { name })
    if (icon === null) {
      actions.prepend(createArchiveButton(sessionId, name, archive))
      changed += 1
    } else {
      // React reused the row element for a different session (keyed list
      // churn): rebind the id; the click handler reads it at click time.
      if (icon.getAttribute(SESSION_ARCHIVE_ID_ATTR) !== sessionId) {
        icon.setAttribute(SESSION_ARCHIVE_ID_ATTR, sessionId)
        changed += 1
      }
      // A rename keeps the row element (React keys) but changes the title;
      // refresh the accessible label so it never names the old title.
      if (icon.getAttribute('aria-label') !== label) {
        icon.setAttribute('aria-label', label)
        changed += 1
      }
    }
  }
  return changed
}

/** Live state readers the overlay mount consumes on each reconcile. */
export interface SessionArchiveMountOptions {
  sessions: () => SessionArchiveListLike
  workspaces: () => SessionArchiveWorkspacesLike
  archive: SessionArchiveFn
  enabled: () => boolean
}

/** Find the sidebar shell root element, or undefined while not yet mounted (same rule as sidebar-entry-core). */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/**
 * Mount the session-row archive overlay: wait for the sidebar shell to render
 * (and survive whole-pane rebuilds), then reconcile on every DOM mutation
 * inside the sidebar and whenever the caller triggers a refresh.
 * @param options - live state readers, the archive operation, and the switch.
 * @returns a disposer plus an explicit reconcile trigger for model changes
 * (renames and archive-set updates arrive as snapshot changes, not DOM
 * mutations, so the caller subscribes them to `reconcile`).
 */
export function mountSessionArchiveButtons(options: SessionArchiveMountOptions): { dispose(): void; reconcile(): void } {
  let root: HTMLElement | undefined
  let observing = false
  let pending = false

  const readState = (): SessionArchiveState => ({
    sessions: options.sessions(),
    workspaces: options.workspaces(),
  })

  const runReconcile = (): void => {
    if (root === undefined || !root.isConnected) return
    try {
      reconcileSessionArchiveRows(root, readState(), options.archive, options.enabled)
    } catch (error) {
      // Cosmetic only: a failed pass leaves the previous buttons (or none).
      console.warn('[dsh-all-tasks] session-row archive reconcile failed:', error)
    }
  }

  const schedule = (): void => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      if (root !== undefined && root.isConnected) runReconcile()
    })
  }

  const attach = (): void => {
    if (observing) return
    observing = true
    rootObserver.observe(root!, { childList: true, subtree: true })
    schedule()
  }

  const tryMount = (): void => {
    if (root !== undefined && !root.isConnected) {
      // The shell rebuilt the sidebar pane: the old observer is gone with the
      // old tree. Detach and re-query from scratch below.
      rootObserver.disconnect()
      root = undefined
      observing = false
    }
    if (root !== undefined) {
      if (!observing) attach()
      return
    }
    if (typeof document === 'undefined') return
    root = sidebarRoot()
    if (root === undefined) return
    attach()
  }

  const rootObserver = new MutationObserver(() => { schedule() })
  // Body-level fallback that only notices the sidebar pane arriving/leaving
  // (sidebar mutations themselves are observed on the root; this watcher must
  // not reconcile on unrelated app churn).
  const waitObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) tryMount()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  tryMount()

  return {
    reconcile: () => { schedule() },
    dispose: () => {
      waitObserver.disconnect()
      rootObserver.disconnect()
      if (root !== undefined && root.isConnected) {
        try {
          reconcileSessionArchiveRows(root, readState(), options.archive, () => false)
        } catch {
          // Best-effort cleanup; a torn-down subtree has nothing left to clean.
        }
      }
      root = undefined
      observing = false
    },
  }
}
