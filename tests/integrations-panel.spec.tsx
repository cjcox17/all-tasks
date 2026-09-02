// @vitest-environment jsdom
/**
 * Events and Actions panels: render one card per registered event source /
 * action from the Host integrations snapshot (names, routes, trigger chips,
 * config rows), surface a retryable error when the fetch fails, and re-fetch
 * when the panel opens.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelController } from '../src/core/panel-controller.ts'
import type { AllTasksIntegrationsSnapshot } from '../src/protocol.ts'
import { ActionsPanel, EventsPanel } from '../src/client/integrations/IntegrationsPanel.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  // The panels localize through the document language; pin English so the
  // assertions match the en dictionary.
  document.documentElement.lang = 'en'
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const SNAPSHOT: AllTasksIntegrationsSnapshot = {
  events: [
    {
      id: 'http',
      method: 'POST',
      path: '/api/all-tasks/events/http',
      config: { tokenEnv: 'DSH_EVENTS_TOKEN', workspaceId: 'w1', autoRun: true },
    },
    {
      id: 'github',
      method: 'POST',
      path: '/api/all-tasks/events/github',
      config: {},
    },
  ],
  actions: [
    { id: 'http', when: ['always'], config: { url: 'https://example.com/hook' } },
    { id: 'spawn', when: ['succeeded'], config: {} },
  ],
}

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

describe('EventsPanel', () => {
  it('renders one card per event source with route and config rows', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new PanelController()
    const container = mount(<EventsPanel controller={controller} />)
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/all-tasks/integrations', expect.objectContaining({ cache: 'no-store' }))
    const cards = container.querySelectorAll('article')
    expect(cards).toHaveLength(2)
    const first = cards[0]!
    expect(first.textContent).toContain('HTTP Webhook')
    expect(first.textContent).toContain('POST /api/all-tasks/events/http')
    expect(first.textContent).toContain('DSH_EVENTS_TOKEN')
    expect(first.textContent).toContain('w1')
    const github = cards[1]!
    expect(github.textContent).toContain('GitHub Webhook')
    expect(github.textContent).toContain('POST /api/all-tasks/events/github')
  })

  it('renders an empty state when no sources are registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { events: [], actions: [] })))
    const container = mount(<EventsPanel controller={new PanelController()} />)
    await flush()
    expect(container.textContent).toContain('No event sources are registered.')
  })

  it('surfaces a retryable error when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { ok: false, error: 'forbidden' })))
    const container = mount(<EventsPanel controller={new PanelController()} />)
    await flush()
    expect(container.textContent).toContain('forbidden')
    expect(container.textContent).toContain('Retry')
  })

  it('re-fetches every time the panel opens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new PanelController()
    mount(<EventsPanel controller={controller} />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    act(() => { controller.openPanel() })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('ActionsPanel', () => {
  it('renders one card per action with trigger chips and config rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, SNAPSHOT)))
    const container = mount(<ActionsPanel controller={new PanelController()} />)
    await flush()

    const cards = container.querySelectorAll('article')
    expect(cards).toHaveLength(2)
    const http = cards[0]!
    expect(http.textContent).toContain('HTTP callback')
    expect(http.textContent).toContain('every settlement')
    expect(http.textContent).toContain('https://example.com/hook')
    const spawn = cards[1]!
    expect(spawn.textContent).toContain('Spawn task')
    expect(spawn.textContent).toContain('succeeded')
  })

  it('renders an empty state when no actions are registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { events: [], actions: [] })))
    const container = mount(<ActionsPanel controller={new PanelController()} />)
    await flush()
    expect(container.textContent).toContain('No actions are registered.')
  })
})
