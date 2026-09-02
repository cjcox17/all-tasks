/**
 * Panel controller: the open/close view state behind one center-column panel
 * (Events, Actions). Framework-free so it is unit-testable with fakes and
 * mirrors the board controller's boardOpen seam.
 */
export interface PanelControllerSnapshot {
  open: boolean
}

/**
 * A single panel's open state with subscriptions. Panels are opened only by
 * explicit user navigation (their sidebar entry) and closed by the panel
 * mount when a sibling panel or a sidebar session/workspace row is clicked.
 */
export class PanelController {
  private open = false
  private readonly listeners = new Set<() => void>()

  getSnapshot(): PanelControllerSnapshot {
    return { open: this.open }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  openPanel(): void {
    if (this.open) return
    this.open = true
    this.notify()
  }

  closePanel(): void {
    if (!this.open) return
    this.open = false
    this.notify()
  }

  togglePanel(): void {
    if (this.open) this.closePanel()
    else this.openPanel()
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
