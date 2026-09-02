/**
 * Center-column panel activation: the shared single-occupancy contract between
 * the task board and the Workflows panel. Exactly one panel is active at a
 * time — opening one evicts the others (both their html attributes and their
 * controller state) — and the shell's session/workspace rows hand the column
 * back to the conversation.
 */
/** Cross-plugin activation event; detail is the activating panel name. */
export const ACTIVATE_EVENT = 'dsh-panel-activate'

/** Every panel that can occupy the center column, mapped to its html activation attribute. */
export const PANEL_ACTIVE_ATTRS: Record<string, string> = {
  'all-tasks': 'data-dsh-all-tasks-active',
  workflows: 'data-dsh-workflows-active',
  ssh: 'data-dsh-ssh-active',
}

/** Panel names the browser half owns (the board + the workflows panel). */
export const OWNED_PANELS = ['all-tasks', 'workflows'] as const

/** Selectors of the shell rows that hand the center column back to the conversation on click. */
export const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/**
 * Activate one panel: clear every activation attribute (including sibling
 * plugins') and set this panel's own, then announce the switch so sibling
 * panels close their controller state. Single-occupant center column.
 * An unknown panel name is a no-op (no attribute is invented).
 * @param name - the activating panel name (a key of {@link PANEL_ACTIVE_ATTRS}).
 */
export function activatePanel(name: string): void {
  for (const attr of Object.values(PANEL_ACTIVE_ATTRS)) {
    document.documentElement.removeAttribute(attr)
  }
  const attr = PANEL_ACTIVE_ATTRS[name]
  if (attr === undefined) return
  document.documentElement.setAttribute(attr, '')
  document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: name }))
}

/** Deactivate one panel (the center column returns to the conversation). */
export function deactivatePanel(name: string): void {
  const attr = PANEL_ACTIVE_ATTRS[name]
  if (attr !== undefined) document.documentElement.removeAttribute(attr)
}
