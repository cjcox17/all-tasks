/**
 * Board view mounting.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the board takes over the center column at
 * the DOM level: a container is appended inside the center column
 * (`[class*="centerCol"]`, the dsh 0.1.0-rc.6 AppFrame layout; previously
 * `[data-pane="conversation"]` on older shells — the mount selector keeps both)
 * as an extra trailing child
 * React never manages, and a stylesheet
 * rule hides the conversation content while the board is active. Toggling is
 * a data attribute on <html> — no React involvement, so the conversation
 * subtree underneath stays mounted and stateful.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { BoardController } from '../core/controller.ts'
import { AllTasks } from './board/AllTasks.tsx'
import css from './board.module.css'
import { activatePanel, deactivatePanel, ACTIVATE_EVENT, SIDEBAR_ROW_SELECTOR } from './panel-activation.ts'

/** The injected board container (kept in the DOM, hidden when inactive). */
export const BOARD_VIEW_SELECTOR = '[data-dsh-all-tasks-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const PANEL_NAME = 'all-tasks'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount the board React tree into the center column and bind its visibility
 * to the controller's boardOpen state.
 * @param controller - the board controller driving the view.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountBoard(controller: BoardController): () => void {
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
    container.dataset.dshAllTasksView = ''
    container.dataset.dshPlugin = 'all-tasks'
    container.className = css.boardView
    column.appendChild(container)
    root = createRoot(container)
    root.render(<AllTasks controller={controller} />)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().boardOpen) {
      // Single-occupant center column: opening the board must evict every
      // sibling panel (Events/Actions, ssh), both its html attribute and its
      // controller state, otherwise the panels' visibility rules fight and
      // the second click appears dead.
      activatePanel(PANEL_NAME)
    } else {
      deactivatePanel(PANEL_NAME)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME && controller.getSnapshot().boardOpen) {
      controller.closeBoard()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // (including the already-current one, which produces no session-change
  // event) hands the center column back to the conversation. Capture phase,
  // so the panel closes before the shell processes the click.
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().boardOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard()
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
    deactivatePanel(PANEL_NAME)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
