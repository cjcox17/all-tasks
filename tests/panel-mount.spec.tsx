// @vitest-environment jsdom
/**
 * Panel mounting: the Events/Actions panels take over the center column the
 * same way the board does — a container inside the conversation column, a
 * single-occupancy html activation attribute, cross-panel eviction through
 * the shared activation event, and a clean disposer.
 */
import { act } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelController } from '../src/core/panel-controller.ts'
import { ACTIVATE_EVENT, PANEL_ACTIVE_ATTRS } from '../src/client/panel-activation.ts'
import { mountPanel } from '../src/client/panel-mount.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let column: HTMLElement
let dispose: (() => void) | undefined

beforeEach(() => {
  document.body.replaceChildren()
  column = document.createElement('div')
  column.className = 'centerCol-fake'
  document.body.appendChild(column)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  for (const attr of Object.values(PANEL_ACTIVE_ATTRS)) document.documentElement.removeAttribute(attr)
})

function mountTestPanel(name: 'events' | 'actions'): PanelController {
  const controller = new PanelController()
  act(() => {
    dispose = mountPanel({
      name,
      viewDataAttr: name === 'events' ? 'dshEventsView' : 'dshActionsView',
      controller,
      render: () => createElement('div', { 'data-test-panel': name }, name),
    })
  })
  return controller
}

describe('mountPanel', () => {
  it('mounts the view container inside the center column', () => {
    const controller = mountTestPanel('events')
    expect(column.querySelector('[data-dsh-events-view]')).not.toBeNull()
    expect(column.querySelector('[data-dsh-events-view]')!.getAttribute('data-dsh-plugin')).toBe('all-tasks')
    expect(column.querySelector('[data-dsh-events-view]')!.textContent).toBe('events')
    expect(controller.getSnapshot().open).toBe(false)
  })

  it('sets the html activation attribute while the panel is open and clears it on close', () => {
    const controller = mountTestPanel('events')
    act(() => { controller.openPanel() })
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-actions-active')).toBe(false)
    act(() => { controller.closePanel() })
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(false)
  })

  it('evicts sibling panels when it opens (single-occupant center column)', () => {
    const controller = mountTestPanel('events')
    act(() => { controller.openPanel() })
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(true)

    const sibling = new PanelController()
    let siblingDispose: (() => void) | undefined
    act(() => {
      siblingDispose = mountPanel({
        name: 'actions',
        viewDataAttr: 'dshActionsView',
        controller: sibling,
        render: () => createElement('div', { 'data-test-panel': 'actions' }, 'actions'),
      })
    })
    act(() => { sibling.openPanel() })

    // The events panel's attribute is gone and its controller state closed.
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(false)
    expect(controller.getSnapshot().open).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-actions-active')).toBe(true)
    siblingDispose?.()
  })

  it('announces the switch through the shared activation event', () => {
    const controller = mountTestPanel('actions')
    const received: string[] = []
    const listener = (event: Event): void => { received.push((event as CustomEvent).detail) }
    document.addEventListener(ACTIVATE_EVENT, listener)
    try {
      act(() => { controller.openPanel() })
    } finally {
      document.removeEventListener(ACTIVATE_EVENT, listener)
    }
    expect(received).toEqual(['actions'])
  })

  it('closes when a sibling panel activates (board opening evicts the panel)', () => {
    const controller = mountTestPanel('events')
    act(() => { controller.openPanel() })
    expect(controller.getSnapshot().open).toBe(true)
    act(() => {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'all-tasks' }))
    })
    expect(controller.getSnapshot().open).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(false)
  })

  it('disposes cleanly: removes the container and the activation attribute', () => {
    const controller = mountTestPanel('events')
    act(() => { controller.openPanel() })
    expect(column.querySelector('[data-dsh-events-view]')).not.toBeNull()
    dispose?.()
    dispose = undefined
    expect(column.querySelector('[data-dsh-events-view]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-dsh-events-active')).toBe(false)
  })
})
