/**
 * Sidebar entry injection — package-specific wiring over the shared core.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into
 * (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already
 * taken), so the entry rows are injected between the shell's New Session
 * button and the workspace browser. The DOM injection / self-healing /
 * idempotency logic lives exactly once in shared/client/sidebar-entry-core.ts
 * (synced copy); this wrapper supplies the icons, copy, CSS module, and the
 * panel toggles for the three rows this package owns — All Tasks, Events, and
 * Actions — ordered through the shared family mechanism so the relative order
 * survives shell re-renders. Each row is plain DOM (no React tree); the view
 * it toggles is a separate React root mounted in the center column
 * (see board-mount.ts and panel-mount.tsx).
 */
import type { BoardController } from '../core/controller.ts'
import type { PanelController } from '../core/panel-controller.ts'
import { t } from './locales.ts'
import css from './board.module.css'
import { mountSidebarEntry as mountSharedSidebarEntry } from './sidebar-entry-core.ts'

/** Stable data attributes identifying the injected entry rows. */
export const ENTRY_SELECTOR = '[data-dsh-all-tasks-entry]'
export const EVENTS_ENTRY_SELECTOR = '[data-dsh-events-entry]'
export const ACTIONS_ENTRY_SELECTOR = '[data-dsh-actions-entry]'

/** The family block this package owns: the three rows, in display order. */
const FAMILY_SELECTORS = [ENTRY_SELECTOR, EVENTS_ENTRY_SELECTOR, ACTIONS_ENTRY_SELECTOR]
/** The same family plus the sibling plugin's ssh row (the board orders against it). */
const FAMILY_WITH_SSH = [...FAMILY_SELECTORS, '[data-dsh-ssh-entry]']

/** Inline icons normalized to the shell's 18px navigation glyph size. */
const BOARD_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'
const EVENTS_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.4 1.6M8 2v1.4M8 12.6V14M2 8h1.4M12.6 8H14M3.8 3.8l1 1M11.2 11.2l1 1"/></svg>'
const ACTIONS_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3.5h8M4 8h8M4 12.5h8"/><path d="M6.5 2v3M10 6.5v3M6.5 11v3"/></svg>'

/**
 * Mount the All Tasks board entry, waiting for the shell to render and
 * self-healing on later React re-renders.
 * @param controller - the board controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(controller: BoardController): () => void {
  return mountSharedSidebarEntry({
    rowAttribute: 'data-dsh-all-tasks-entry',
    rowSelector: ENTRY_SELECTOR,
    plugin: 'all-tasks',
    icon: BOARD_ICON,
    css,
    label: () => t('entry.label'),
    onToggle: () => { controller.toggleBoard() },
    position: 'before',
    familySelectors: FAMILY_WITH_SSH,
    active: {
      subscribe: (listener) => controller.subscribe(listener),
      isOpen: () => controller.getSnapshot().boardOpen,
    },
  })
}

/** One Events/Actions row's wiring (same shape as the board entry, different panel). */
function mountPanelEntry(options: {
  rowAttribute: string
  rowSelector: string
  icon: string
  label: () => string
  panel: PanelController
}): () => void {
  return mountSharedSidebarEntry({
    rowAttribute: options.rowAttribute,
    rowSelector: options.rowSelector,
    plugin: 'all-tasks',
    icon: options.icon,
    css,
    label: options.label,
    onToggle: () => { options.panel.togglePanel() },
    // 'after' anchors behind the last owned family row (the board entry or the
    // previously mounted Events row), so the block reads All Tasks → Events →
    // Actions regardless of when the ssh row lands.
    position: 'after',
    familySelectors: FAMILY_SELECTORS,
    active: {
      subscribe: (listener) => options.panel.subscribe(listener),
      isOpen: () => options.panel.getSnapshot().open,
    },
  })
}

/**
 * Mount the Events sidebar entry below All Tasks.
 * @param panel - the events panel controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountEventsSidebarEntry(panel: PanelController): () => void {
  return mountPanelEntry({
    rowAttribute: 'data-dsh-events-entry',
    rowSelector: EVENTS_ENTRY_SELECTOR,
    icon: EVENTS_ICON,
    label: () => t('entry.events'),
    panel,
  })
}

/**
 * Mount the Actions sidebar entry below Events.
 * @param panel - the actions panel controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountActionsSidebarEntry(panel: PanelController): () => void {
  return mountPanelEntry({
    rowAttribute: 'data-dsh-actions-entry',
    rowSelector: ACTIONS_ENTRY_SELECTOR,
    icon: ACTIONS_ICON,
    label: () => t('entry.actions'),
    panel,
  })
}
