/**
 * Panel view mounting — the shared center-column panel host used by the
 * Workflows panel (the task board keeps its own mount in board-mount.tsx
 * because it predates this helper).
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so a panel takes over the center column at
 * the DOM level: a container is appended inside the center column
 * (`[class*="centerCol"]`, the dsh 0.1.0-rc.6 AppFrame layout; previously
 * `[data-pane="conversation"]` on older shells — the mount selector keeps both)
 * as an extra trailing child React never manages, and a stylesheet rule hides
 * the conversation content while the panel is active. Toggling is a data
 * attribute on <html> — no React involvement, so the conversation subtree
 * underneath stays mounted and stateful.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import type { PanelController } from '../core/panel-controller.ts'
import { activatePanel, deactivatePanel, ACTIVATE_EVENT, SIDEBAR_ROW_SELECTOR } from './panel-activation.ts'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'

/** Options for one center-column panel mount. */
export interface PanelMountOptions {
  /** Panel name used in the cross-plugin activation event detail. */
  name: string
  /**
   * The data-attribute name set on the injected container; the container is
   * styled by the matching `[data-dsh-<name>-view]` attribute rule (e.g.
   * `dshWorkflowsView` → `data-dsh-workflows-view`).
   */
  viewDataAttr: string
  /** The controller whose open state drives the panel's visibility. */
  controller: PanelController
  /** The panel React tree to render. */
  render: () => ReactElement
}

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount a panel React tree into the center column and bind its visibility to
 * the controller's open state.
 * @param options - panel identity, controller, and view.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountPanel(options: PanelMountOptions): () => void {
  const { name, viewDataAttr, controller } = options
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset[viewDataAttr] = ''
    container.dataset.dshPlugin = 'all-tasks'
    column.appendChild(container)
    root = createRoot(container)
    root.render(options.render())
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().open) {
      // Single-occupant center column: opening this panel must evict every
      // sibling panel (board, other panel, ssh), both its html attribute and
      // its controller state, otherwise the panels' visibility rules fight
      // and the second click appears dead.
      activatePanel(name)
    } else {
      deactivatePanel(name)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== name && controller.getSnapshot().open) {
      controller.closePanel()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // (including the already-current one, which produces no session-change
  // event) hands the center column back to the conversation. Capture phase,
  // so the panel closes before the shell processes the click.
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closePanel()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    deactivatePanel(name)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
