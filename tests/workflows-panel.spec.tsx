// @vitest-environment jsdom
/**
 * Workflows panel: renders the workflow list from the board controller's
 * snapshot, fetches the node palette from the integrations endpoint, and seeds
 * a new workflow with a minimal event → action graph on "New workflow".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelController } from '../src/core/panel-controller.ts'
import { WorkflowsPanel } from '../src/client/workflows/WorkflowsPanel.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  document.documentElement.lang = 'en'
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const INTEGRATIONS = {
  events: [{ id: 'http', method: 'POST', path: '/api/all-tasks/events/http', config: {} }],
  actions: [{ id: 'http', when: ['always'], config: {} }],
}

function mount(panel: PanelController, controller: unknown): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<WorkflowsPanel panel={panel} controller={controller as never} />) })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

function fakeController(snapshot: { workflows: unknown[]; tasks: unknown[] }) {
  const stable = snapshot
  return {
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => stable,
    createWorkflow: vi.fn(async () => undefined),
    updateWorkflow: vi.fn(async () => true),
    deleteWorkflow: vi.fn(async () => true),
  }
}

describe('WorkflowsPanel', () => {
  it('renders the empty state and fetches the node palette', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, INTEGRATIONS))
    vi.stubGlobal('fetch', fetchMock)
    const controller = fakeController({ workflows: [], tasks: [] })
    const container = mount(new PanelController(), controller)
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/all-tasks/integrations', expect.objectContaining({ cache: 'no-store' }))
    expect(container.textContent).toContain('No workflows yet')
  })

  it('seeds a new workflow with an event → action graph', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, INTEGRATIONS)))
    const controller = fakeController({ workflows: [], tasks: [] })
    const container = mount(new PanelController(), controller)
    await flush()

    const newButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('New workflow'))
    expect(newButton).toBeDefined()
    act(() => { newButton!.click() })
    await flush()

    expect(controller.createWorkflow).toHaveBeenCalledTimes(1)
    const input = (controller.createWorkflow as ReturnType<typeof vi.fn>).mock.calls[0][0] as { nodes: { id: string; type: string }[]; edges: { source: string; target: string }[] }
    expect(input.nodes.map(n => n.type)).toEqual(['event', 'action'])
    expect(input.edges).toHaveLength(1)
    expect(input.edges[0]!.source).toBe(input.nodes[0]!.id)
    expect(input.edges[0]!.target).toBe(input.nodes[1]!.id)
  })

  it('renders one card per workflow with node/edge counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, INTEGRATIONS)))
    const workflow = {
      id: 'wf-1',
      name: 'Deploy',
      nodes: [{ id: 'n1', type: 'event', ref: 'http', position: { x: 0, y: 0 } }],
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const controller = fakeController({ workflows: [workflow], tasks: [] })
    const container = mount(new PanelController(), controller)
    await flush()

    expect(container.textContent).toContain('Deploy')
    expect(container.textContent).toContain('nodes')
  })
})
