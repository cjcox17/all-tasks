// @vitest-environment jsdom
/**
 * Endpoints editor: renders the configured endpoints, edits rows (provider
 * select limits models/default model; per-endpoint timeouts), reorders, and
 * writes a full replacement through the board's endpoints routes so the task
 * modal's dropdown picks the change up live.
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
      id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio',
      models: ['qwen/qwen3.8-27b'], defaultModel: 'qwen/qwen3.8-27b',
      idleSeconds: 900, totalSeconds: 3600,
    },
  ],
  defaultEndpoints: ['lm-studio-nas'],
  providers: [
    { provider: 'lm-studio', displayName: 'LM Studio', namespace: 'llm-pi-ai', models: ['qwen/qwen3.8-27b', 'qwen/qwen3-coder-30b'], streamIdleTimeoutMs: 900_000, timeoutMs: 3_600_000 },
    { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', models: ['deepseek-chat', 'deepseek-reasoner'], streamIdleTimeoutMs: 300_000 },
  ],
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
  it('renders each endpoint prefilled (provider, model list, timeouts) and the default order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, GET_BODY)))
    const container = mount()
    await flush()

    expect(container.querySelector('[data-dsh-part="endpoints-editor"]')).not.toBeNull()
    const row = rowOf(container, 'lm-studio-nas')
    expect(inputOf(row, 'endpoint-id-0').value).toBe('lm-studio-nas')
    expect(inputOf(row, 'endpoint-name-0').value).toBe('LM Studio (NAS)')
    expect(inputOf(row, 'endpoint-idle-0').value).toBe('900')
    expect(inputOf(row, 'endpoint-total-0').value).toBe('3600')
    // The provider's model list renders as checkboxes (models: 2 known).
    const modelBoxes = row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(modelBoxes.length).toBe(2)
    expect(Array.from(modelBoxes).filter(box => box.checked).length).toBe(1)
    const order = container.querySelector('[data-dsh-part="default-endpoints"]')
    expect(order?.textContent).toContain('LM Studio (NAS)')
  })

  it('adds a blank row, picks a provider, and saves a full replacement', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(200, {
          endpoints: [{ ...GET_BODY.endpoints[0], idleSeconds: 600 }],
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
    act(() => { setValue(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-idle-0'), '600') })
    // The appended row needs a provider before the whole list can save.
    const blank = rowOf(container, 'endpoint-2')
    const providerSelect = blank.querySelector<HTMLSelectElement>('select[id$="endpoint-provider-1"]')
    if (providerSelect === null) throw new Error('missing provider select')
    act(() => {
      providerSelect.value = 'deepseek-official'
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => { buttonByText(container, 'settings.endpointSave').click() })
    await flush()

    const posts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    const body = JSON.parse(String((posts[0][1] as RequestInit).body)) as { endpoints: Array<Record<string, unknown>>; defaultEndpoints?: string[] }
    expect(body.endpoints[0]).toMatchObject({ id: 'lm-studio-nas', provider: 'lm-studio', idleSeconds: 600 })
    expect(body.endpoints[1]).toMatchObject({ id: 'endpoint-2', provider: 'deepseek-official' })
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

    // A malformed idle timeout is rejected too.
    act(() => { setValue(inputOf(blankIdRow, 'endpoint-id-0'), 'lm-studio-nas') })
    act(() => { setValue(inputOf(rowOf(container, 'lm-studio-nas'), 'endpoint-idle-0'), '0') })
    act(() => { buttonByText(container, 'settings.endpointSave').click() })
    await flush()
    expect(rowOf(container, 'lm-studio-nas').querySelector('[role="alert"]')?.textContent).toBe('settings.endpointInvalidNumber')
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
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, GET_BODY))
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
