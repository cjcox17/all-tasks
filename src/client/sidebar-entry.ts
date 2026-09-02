/**
 * Sidebar entry injection — package-specific wiring over the shared core.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into
 * (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already
 * taken), so the entry rows are injected between the shell's New Session
 * button and the workspace browser. The DOM injection / self-healing /
 * idempotency logic lives exactly once in shared/client/sidebar-entry-core.ts
 * (synced copy); this wrapper supplies the icons, copy, CSS module, and the
 * panel toggles for the two rows this package owns — All Tasks and WorkFlows —
 * ordered through the shared family mechanism so the relative order survives
 * shell re-renders. Each row is plain DOM (no React tree); the view it toggles
 * is a separate React root mounted in the center column (see board-mount.tsx
 * and panel-mount.tsx).
 */
import type { BoardController } from '../core/controller.ts'
import type { PanelController } from '../core/panel-controller.ts'
import { t } from './locales.ts'
import css from './board.module.css'
import { mountSidebarEntry as mountSharedSidebarEntry } from './sidebar-entry-core.ts'

/** Stable data attributes identifying the injected entry rows. */
export const ENTRY_SELECTOR = '[data-dsh-all-tasks-entry]'
export const WORKFLOWS_ENTRY_SELECTOR = '[data-dsh-workflows-entry]'

/** The family block this package owns: the two rows, in display order. */
const FAMILY_SELECTORS = [ENTRY_SELECTOR, WORKFLOWS_ENTRY_SELECTOR]
/** The same family plus the sibling plugin's ssh row (the board orders against it). */
const FAMILY_WITH_SSH = [...FAMILY_SELECTORS, '[data-dsh-ssh-entry]']

/** Inline icons normalized to the shell's 18px navigation glyph size. */
const BOARD_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'
const WORKFLOWS_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="3.5" cy="3.5" r="1.6"/><circle cx="12.5" cy="8" r="1.6"/><circle cx="3.5" cy="12.5" r="1.6"/><path d="M5 4l6 3.4M5 12l6-3.4"/></svg>'

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

/**
 * Mount the Workflows sidebar entry below All Tasks.
 * @param panel - the workflows panel controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountWorkflowsSidebarEntry(panel: PanelController): () => void {
  return mountSharedSidebarEntry({
    rowAttribute: 'data-dsh-workflows-entry',
    rowSelector: WORKFLOWS_ENTRY_SELECTOR,
    plugin: 'all-tasks',
    icon: WORKFLOWS_ICON,
    css,
    label: () => t('entry.workflows'),
    onToggle: () => { panel.togglePanel() },
    // 'after' anchors behind the last owned family row (the board entry), so
    // the block reads All Tasks → WorkFlows regardless of when the ssh row lands.
    position: 'after',
    familySelectors: FAMILY_SELECTORS,
    active: {
      subscribe: (listener) => panel.subscribe(listener),
      isOpen: () => panel.getSnapshot().open,
    },
  })
}
