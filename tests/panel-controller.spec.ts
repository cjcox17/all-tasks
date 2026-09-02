import { describe, expect, it, vi } from 'vitest'
import { PanelController } from '../src/core/panel-controller.ts'

describe('PanelController', () => {
  it('starts closed and opens/closes/toggles', () => {
    const controller = new PanelController()
    expect(controller.getSnapshot().open).toBe(false)
    controller.openPanel()
    expect(controller.getSnapshot().open).toBe(true)
    // Opening twice is a no-op (no extra notification).
    controller.openPanel()
    expect(controller.getSnapshot().open).toBe(true)
    controller.closePanel()
    expect(controller.getSnapshot().open).toBe(false)
    controller.togglePanel()
    expect(controller.getSnapshot().open).toBe(true)
    controller.togglePanel()
    expect(controller.getSnapshot().open).toBe(false)
  })

  it('notifies subscribers on every state change', () => {
    const controller = new PanelController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    controller.openPanel()
    expect(listener).toHaveBeenCalledTimes(1)
    controller.closePanel()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    controller.openPanel()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
