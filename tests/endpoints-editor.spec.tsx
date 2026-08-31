// @vitest-environment jsdom
/**
 * Endpoints editor: renders the configured endpoints, edits rows, reorders,
 * and writes a full replacement through the board's endpoints routes so the
 * task modal's dropdown picks the change up live.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EndpointsEditor } from '../src/client/EndpointsEditor.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function mount(disabled = false): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<EndpointsEditor t={(key) => String(key)} disabled={disabled} />)
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

const GET_BODY = {
  endpoints: [
    {
      id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'],
      defaultModel: '', maxConcurrency: 2, maxTokens: 8192,
      allowedHours: { start: '', end: '' }, offPeakOnly: false,
      offPeak: { start: '16:30', end: '00:30', timezone: 'UTC' },
    },
  ],
  defaultEndpoints: ['lm-studio-nas'],
  providers: ['lm-studio', 'deepseek-official'],
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function nativeValueSetter(): (element: HTMLInputElement, value: string) => void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  return (element, value) => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.includes(text))
  if (button === undefined) throw new Error(`missing button ${text}`)
  return button
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-endpoint="${id}"]`)
  if (row === null) throw new Error(`missing endpoint row ${id}`)
  return row
}

function inputOf(row: HTMLElement, idSuffix: string): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>(`input[id$="${idSuffix}"]`)
  if (input === null) throw new Error(`missing input ${idSuffix}`)
  return input
}

describe('EndpointsEditor', () => {
  it('renders each endpoint prefilled and the default order list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, GET_BODY)))
    const container = mount()
    await flush()

    expect(container.querySelector('[data-dsh-part="endpoints-editor"]')).not.toBeNull()
    const row = rowOf(container, 'lm-studio-nas')
    expect(inputOf(row, 'endpoint-id-0').value).toBe('lm-studio-nas')
    expect(inputOf(row, 'endpoint-name-0').value).toBe('LM Studio (NAS)')
    expect(inputOf(row, 'endpoint-provider-0').value).toBe('lm-studio')
    expect(inputOf(row, 'endpoint-models-0').value).toBe('qwen/qwen3.8-27b')
    expect(inputOf(row, 'endpoint-concurrency-0').value).toBe('2')
    const order = container.querySelector('[data-dsh-part="default-endpoints"]')
    expect(order?.textContent).toContain('LM Studio (NAS)')
    // The provider field completes from the known provider routes.
    expect(container.querySelector('#endpoint-providers')).not.toBeNull()
  })

  it('adds a blank row and saves a full replacement', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(200, {
          endpoints: [{ ...GET_BODY.endpoints[0], maxConcurrency: 3 }],
          defaultEndpoints: ['lm-studio-nas'],
        })
      }
      return jsonResponse(200, GET_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    act(() => { buttonByText(container, 'settings.endpointAdd').click() })
    await flush()
    expect(container.querySelectorAll('[data-endpoint]').length).toBe(2)

    const setValue = nativeValueSetter()
    act(() => { setValue(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-concurrency-0'), '3') })
    // The appended row must be complete before the whole list can save.
    act(() => { setValue(inputOf(rowOf(container, 'endpoint-2'), 'endpoint-provider-1'), 'deepseek') })
    act(() => { buttonByText(container, 'settings.endpointSave').click() })
    await flush()

    const posts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    const body = JSON.parse(String((posts[0][1] as RequestInit).body)) as { endpoints: Array<Record<string, unknown>>; defaultEndpoints?: string[] }
    expect(body.endpoints[0]).toMatchObject({ id: 'lm-studio-nas', provider: 'lm-studio', maxConcurrency: 3 })
    expect(body.endpoints[1]).toMatchObject({ id: 'endpoint-2', provider: 'deepseek' })
    expect(body.defaultEndpoints).toEqual(['lm-studio-nas'])
    expect(container.textContent).toContain('settings.endpointSaved')
  })

  it('rejects invalid rows locally without posting', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, GET_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const setValue = nativeValueSetter()
    act(() => { setValue(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-id-0'), '') })
    act(() => { buttonByText(container, 'settings.endpointSave').click() })
    await flush()
    // Blanking the id changes the row's data-endpoint marker; re-query it.
    const blankIdRow = rowOf(container, 'row-0')
    expect(blankIdRow.querySelector('[role="alert"]')?.textContent).toBe('settings.endpointInvalidId')
    expect(fetchMock.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)

    // A malformed allowed-hours window is rejected too.
    act(() => { setValue(inputOf(blankIdRow, 'endpoint-id-0'), 'lm-studio-nas') })
    act(() => { setValue(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-allowed-start-0'), '25:00') })
    act(() => { buttonByText(container, 'settings.endpointSave').click() })
    await flush()
    expect(rowOf(container, 'lm-studio-nas').querySelector('[role="alert"]')?.textContent).toBe('settings.endpointInvalidTime')
    expect(fetchMock.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('surfaces a failed load instead of rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const container = mount()
    await flush()

    const section = container.querySelector('[data-dsh-part="endpoints-editor"]')
    expect(section?.textContent).toContain('settings.endpointUnavailable')
    expect(container.querySelector('[data-endpoint]')).toBeNull()
  })

  it('discards local edits and reloads on reset', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(200, GET_BODY)
      return jsonResponse(200, GET_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const row = rowOf(container, 'lm-studio-nas')
    const setValue = nativeValueSetter()
    act(() => { setValue(inputOf(row, 'endpoint-name-0'), 'Renamed') })
    act(() => { buttonByText(container, 'settings.endpointReset').click() })
    await flush()
    expect(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-name-0').value).toBe('LM Studio (NAS)')
  })
})
