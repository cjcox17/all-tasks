// @vitest-environment jsdom
/**
 * Model-timeouts editor: renders one row per provider with the current
 * effective timeouts, writes a raised default straight to the board's
 * model-timeouts routes, and surfaces validation/unavailability inline.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelTimeoutsEditor } from '../src/client/ModelTimeoutsEditor.tsx'

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
    root.render(<ModelTimeoutsEditor t={(key) => String(key)} disabled={disabled} />)
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

const GET_BODY = {
  providers: [
    { provider: 'lm-studio', displayName: 'LM Studio', namespace: 'llm-pi-ai', streamIdleTimeoutMs: 300_000, timeoutMs: 900_000 },
    { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', streamIdleTimeoutMs: 300_000 },
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

function rowOf(container: HTMLElement, provider: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-provider="${provider}"]`)
  if (row === null) throw new Error(`missing provider row ${provider}`)
  return row
}

function inputOf(row: HTMLElement, idSuffix: string): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>(`input[id$="${idSuffix}"]`)
  if (input === null) throw new Error(`missing input ${idSuffix}`)
  return input
}

describe('ModelTimeoutsEditor', () => {
  it('renders each provider row prefilled with its effective timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, GET_BODY)))
    const container = mount()
    await flush()

    const section = container.querySelector('[data-dsh-part="model-timeouts"]')
    expect(section).not.toBeNull()
    const lm = rowOf(container, 'lm-studio')
    expect(inputOf(lm, 'model-timeout-idle-lm-studio').value).toBe('300')
    expect(inputOf(lm, 'model-timeout-total-lm-studio').value).toBe('900')
    const deep = rowOf(container, 'deepseek-official')
    expect(inputOf(deep, 'model-timeout-idle-deepseek-official').value).toBe('300')
    // The official route has no total-request bound in its settings schema.
    expect(deep.querySelector('input[id$="model-timeout-total-deepseek-official"]')).toBeNull()
  })

  it('posts a raised idle timeout and renders the updated value', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(200, {
          provider: { provider: 'lm-studio', displayName: 'LM Studio', namespace: 'llm-pi-ai', streamIdleTimeoutMs: 600_000 },
        })
      }
      return jsonResponse(200, GET_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const lm = rowOf(container, 'lm-studio')
    const setValue = nativeValueSetter()
    act(() => {
      setValue(inputOf(lm, 'model-timeout-idle-lm-studio'), '600')
      setValue(inputOf(lm, 'model-timeout-total-lm-studio'), '')
    })
    act(() => {
      lm.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flush()

    const posts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    const [url, init] = posts[0]
    expect(String(url)).toMatch(/\/api\/task-board\/model-timeouts$/)
    expect(JSON.parse(String(init?.body))).toEqual({ provider: 'lm-studio', streamIdleTimeoutMs: 600_000, timeoutMs: null })
    expect(inputOf(rowOf(container, 'lm-studio'), 'model-timeout-idle-lm-studio').value).toBe('600')
    expect(rowOf(container, 'lm-studio').textContent).toContain('settings.modelTimeoutSaved')
  })

  it('keeps the deepseek row free of the total-timeout field on save', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(200, {
          provider: { provider: 'deepseek-official', displayName: 'DeepSeek', namespace: 'llm-deepseek', streamIdleTimeoutMs: 600_000 },
        })
      }
      return jsonResponse(200, GET_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const deep = rowOf(container, 'deepseek-official')
    const setValue = nativeValueSetter()
    act(() => { setValue(inputOf(deep, 'model-timeout-idle-deepseek-official'), '600') })
    act(() => { deep.querySelector<HTMLButtonElement>('button')?.click() })
    await flush()

    const posts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ provider: 'deepseek-official', streamIdleTimeoutMs: 600_000 })
  })

  it('rejects invalid seconds locally without posting', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, GET_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const lm = rowOf(container, 'lm-studio')
    const setValue = nativeValueSetter()
    act(() => { setValue(inputOf(lm, 'model-timeout-idle-lm-studio'), '0') })
    act(() => { lm.querySelector<HTMLButtonElement>('button')?.click() })
    await flush()

    expect(lm.querySelector('[role="alert"]')?.textContent).toBe('settings.modelTimeoutInvalid')
    expect(fetchMock.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('surfaces a failed load instead of rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request) => { throw new Error('network down') }))
    const container = mount()
    await flush()

    const section = container.querySelector('[data-dsh-part="model-timeouts"]')
    expect(section?.textContent).toContain('settings.modelTimeoutUnavailable')
    expect(container.querySelector('[data-provider]')).toBeNull()
  })

  it('posts a null patch when resetting a row to defaults', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(200, {
          provider: { provider: 'lm-studio', displayName: 'LM Studio', namespace: 'llm-pi-ai', streamIdleTimeoutMs: 300_000 },
        })
      }
      return jsonResponse(200, GET_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mount()
    await flush()

    const lm = rowOf(container, 'lm-studio')
    const buttons = lm.querySelectorAll<HTMLButtonElement>('button')
    expect(buttons.length).toBeGreaterThan(1)
    act(() => { buttons[1].click() })
    await flush()

    const posts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ provider: 'lm-studio', streamIdleTimeoutMs: null, timeoutMs: null })
  })
})
