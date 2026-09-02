// @vitest-environment jsdom
/**
 * Session-row archive buttons: the row→session resolver (title-first, then
 * anchor-verified positional mapping for duplicate titles) and the reconcile
 * pass that injects/refreshes/removes the archive icon buttons.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createArchiveButton,
  dropRowIcon,
  reconcileSessionArchiveRows,
  resolveRowSessionId,
  sessionRowTitle,
  SESSION_ARCHIVE_ATTR,
  SESSION_ARCHIVE_ID_ATTR,
  type SessionArchiveListLike,
  type SessionArchiveState,
  type SessionArchiveSummaryLike,
  type SessionArchiveWorkspacesLike,
} from '../src/client/session-archive.ts'

// The all-tasks dictionary selects by document language; pin English so the
// injected labels are deterministic in jsdom.
document.documentElement.lang = 'en'

function summary(id: string, displayTitle: string, extra: Partial<SessionArchiveSummaryLike> = {}): SessionArchiveSummaryLike {
  return { id, displayTitle, ...extra }
}

function byId(...sessions: SessionArchiveSummaryLike[]): Record<string, SessionArchiveSummaryLike> {
  return Object.fromEntries(sessions.map(session => [session.id, session]))
}

/** One official `…sessionRow` (title span + hover actions span with the "…" anchor). */
function row(title: string, actions = true): HTMLElement {
  const element = document.createElement('div')
  element.className = 'hash_sessionRow'
  const titleSpan = document.createElement('span')
  titleSpan.className = 'hash_title'
  titleSpan.textContent = title
  element.appendChild(titleSpan)
  if (actions) {
    const actionsSpan = document.createElement('span')
    actionsSpan.className = 'hash_rowActions'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'hash_iconButton'
    more.setAttribute('aria-label', `Session actions for ${title}`)
    actionsSpan.appendChild(more)
    element.appendChild(actionsSpan)
  }
  return element
}

/** One workspace section: project row (title) + session rows, like the official tree. */
function section(workspaceTitle: string, rows: HTMLElement[]): HTMLElement {
  const group = document.createElement('div')
  group.className = 'hash_groupSection'
  const project = document.createElement('div')
  project.className = 'hash_projectRow'
  const text = document.createElement('div')
  text.className = 'hash_projectText'
  const title = document.createElement('span')
  title.className = 'hash_title'
  title.textContent = workspaceTitle
  text.appendChild(title)
  project.appendChild(text)
  group.appendChild(project)
  for (const item of rows) group.appendChild(item)
  return group
}

function states(
  sessions: SessionArchiveSummaryLike[],
  workspace: { workspaceId: string; title: string; sessionIds: string[] },
  archived: string[] = [],
): { sessions: SessionArchiveListLike; workspaces: SessionArchiveWorkspacesLike } {
  return {
    sessions: { byId: byId(...sessions) },
    workspaces: {
      items: [{ workspaceId: workspace.workspaceId, title: workspace.title, sessionIds: workspace.sessionIds }],
      archivedSessionIds: archived,
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('sessionRowTitle', () => {
  it('reads the displayed title from the title span', () => {
    expect(sessionRowTitle(row('Ship it'))).toBe('Ship it')
  })

  it('returns undefined for a row without a title span', () => {
    const bare = document.createElement('div')
    bare.className = 'hash_sessionRow'
    expect(sessionRowTitle(bare)).toBeUndefined()
  })
})

describe('resolveRowSessionId', () => {
  it('resolves a row by its unique title without needing a section', () => {
    const node = row('Unique session')
    document.body.appendChild(node)
    const { sessions, workspaces } = states(
      [summary('s1', 'Unique session'), summary('s2', 'Something else')],
      { workspaceId: 'w1', title: 'Workspace', sessionIds: ['s1', 's2'] },
    )
    expect(resolveRowSessionId(node, sessions, workspaces)).toBe('s1')
  })

  it('returns undefined for an unknown title', () => {
    const node = row('Ghost')
    document.body.appendChild(node)
    const { sessions, workspaces } = states([summary('s1', 'Real session')], { workspaceId: 'w1', title: 'Workspace', sessionIds: ['s1'] })
    expect(resolveRowSessionId(node, sessions, workspaces)).toBeUndefined()
  })

  it('ignores archived, subagent, and non-current blank sessions', () => {
    const node = row('Taken')
    document.body.appendChild(node)
    const { sessions, workspaces } = states(
      [
        summary('s-archived', 'Taken'),
        summary('s-sub', 'Taken', { origin: 'subagent' }),
        summary('s-blank', 'Taken', { blank: true }),
        summary('s-real', 'Real'),
      ],
      { workspaceId: 'w1', title: 'Workspace', sessionIds: ['s-archived', 's-sub', 's-blank', 's-real'] },
      ['s-archived'],
    )
    expect(resolveRowSessionId(node, sessions, workspaces)).toBeUndefined()
  })

  it('maps duplicate titles by position inside a verified, anchored section', () => {
    const dup1 = row('Same task')
    const anchor = row('Anchor session')
    const dup2 = row('Same task')
    const group = section('All Tasks', [anchor, dup1, dup2])
    document.body.appendChild(group)
    // Account order: anchor, then two runs of "Same task".
    const { sessions, workspaces } = states(
      [summary('a1', 'Anchor session'), summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['a1', 'd1', 'd2'] },
    )
    expect(resolveRowSessionId(dup1, sessions, workspaces)).toBe('d1')
    expect(resolveRowSessionId(dup2, sessions, workspaces)).toBe('d2')
  })

  it('refuses duplicates in a section without a unique-title anchor', () => {
    const dup1 = row('Same task')
    const dup2 = row('Same task')
    const group = section('All Tasks', [dup1, dup2])
    document.body.appendChild(group)
    const { sessions, workspaces } = states(
      [summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['d1', 'd2'] },
    )
    expect(resolveRowSessionId(dup1, sessions, workspaces)).toBeUndefined()
    expect(resolveRowSessionId(dup2, sessions, workspaces)).toBeUndefined()
  })

  it('refuses duplicates when a differently-named row was displaced (drag reorder)', () => {
    const dup = row('Same task')
    const anchor = row('Anchor session')
    const dup2 = row('Same task')
    // A duplicate was dragged above the anchor: the DOM no longer matches the
    // recorded account order, and the title sequence check must refuse.
    const group = section('All Tasks', [dup, anchor, dup2])
    document.body.appendChild(group)
    const { sessions, workspaces } = states(
      [summary('a1', 'Anchor session'), summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['a1', 'd1', 'd2'] },
    )
    expect(resolveRowSessionId(dup, sessions, workspaces)).toBeUndefined()
    expect(resolveRowSessionId(dup2, sessions, workspaces)).toBeUndefined()
  })

  it('refuses duplicates outside a section (flat "In one list" view)', () => {
    const dup1 = row('Same task')
    const dup2 = row('Same task')
    document.body.append(dup1, dup2)
    const { sessions, workspaces } = states(
      [summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['d1', 'd2'] },
    )
    expect(resolveRowSessionId(dup1, sessions, workspaces)).toBeUndefined()
  })

  it('refuses duplicates when the section is truncated (rows < members)', () => {
    const dup = row('Same task')
    const group = section('All Tasks', [dup])
    document.body.appendChild(group)
    const { sessions, workspaces } = states(
      [summary('d1', 'Same task'), summary('d2', 'Same task'), summary('d3', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['d1', 'd2', 'd3'] },
    )
    expect(resolveRowSessionId(dup, sessions, workspaces)).toBeUndefined()
  })

  it('resolves each workspace section independently when names repeat across workspaces', () => {
    const dupA = row('Sync')
    const dupB = row('Sync')
    const sectionA = section('Workspace A', [row('Anchor A'), dupA])
    const sectionB = section('Workspace B', [row('Anchor B'), dupB])
    document.body.append(sectionA, sectionB)
    const sessions: SessionArchiveListLike = {
      byId: byId(
        summary('a-anchor', 'Anchor A'),
        summary('a-sync', 'Sync'),
        summary('b-anchor', 'Anchor B'),
        summary('b-sync', 'Sync'),
      ),
    }
    const workspaces: SessionArchiveWorkspacesLike = {
      items: [
        { workspaceId: 'wa', title: 'Workspace A', sessionIds: ['a-anchor', 'a-sync'] },
        { workspaceId: 'wb', title: 'Workspace B', sessionIds: ['b-anchor', 'b-sync'] },
      ],
    }
    expect(resolveRowSessionId(dupA, sessions, workspaces)).toBe('a-sync')
    expect(resolveRowSessionId(dupB, sessions, workspaces)).toBe('b-sync')
  })

  it('refuses duplicates inside a section whose workspace is unknown', () => {
    const dup1 = row('Same task')
    const dup2 = row('Same task')
    const group = section('Unknown workspace', [row('Anchor'), dup1, dup2])
    document.body.appendChild(group)
    const { sessions, workspaces } = states(
      [summary('a', 'Anchor'), summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'Real workspace', sessionIds: ['a', 'd1', 'd2'] },
    )
    expect(resolveRowSessionId(dup1, sessions, workspaces)).toBeUndefined()
  })
})

describe('reconcileSessionArchiveRows', () => {
  const always = (): boolean => true

  it('injects an icon into every resolvable row and is idempotent', () => {
    const unique = row('Unique')
    const dup1 = row('Same task')
    const dup2 = row('Same task')
    const group = section('All Tasks', [unique, dup1, dup2])
    document.body.appendChild(group)
    const { sessions, workspaces } = states(
      [summary('u', 'Unique'), summary('d1', 'Same task'), summary('d2', 'Same task')],
      { workspaceId: 'w1', title: 'All Tasks', sessionIds: ['u', 'd1', 'd2'] },
    )
    const archive = vi.fn(async () => {})
    const state: SessionArchiveState = { sessions, workspaces }

    const changed = reconcileSessionArchiveRows(group, state, archive, always)
    expect(changed).toBe(3)
    expect(group.querySelectorAll(`[${SESSION_ARCHIVE_ATTR}]`)).toHaveLength(3)
    expect(unique.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)?.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('u')
    expect(dup1.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)?.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('d1')
    expect(dup2.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)?.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('d2')

    // A second pass changes nothing (idempotent).
    expect(reconcileSessionArchiveRows(group, state, archive, always)).toBe(0)
    expect(group.querySelectorAll(`[${SESSION_ARCHIVE_ATTR}]`)).toHaveLength(3)
  })

  it('never decorates rows without an actions span (blank/New Session rows)', () => {
    const blank = row('New Session', false)
    const unique = row('Unique')
    document.body.append(blank, unique)
    const { sessions, workspaces } = states([summary('u', 'Unique')], { workspaceId: 'w1', title: 'Workspace', sessionIds: ['u'] })
    const state: SessionArchiveState = { sessions, workspaces }
    const changed = reconcileSessionArchiveRows(document.body, state, vi.fn(async () => {}), always)
    expect(changed).toBe(1)
    expect(blank.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).toBeNull()
    expect(unique.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).not.toBeNull()
  })

  it('removes an icon when the row no longer resolves (rename/unknown title)', () => {
    const unique = row('Old name')
    document.body.appendChild(unique)
    const sessions = { byId: byId(summary('u', 'Old name')) }
    const workspaces: SessionArchiveWorkspacesLike = { items: [] }
    const state: SessionArchiveState = { sessions, workspaces }
    const archive = vi.fn(async () => {})
    expect(reconcileSessionArchiveRows(document.body, state, archive, always)).toBe(1)
    expect(unique.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).not.toBeNull()

    // The host renamed the session (its row now shows a title with no match).
    const titleSpan = unique.querySelector<HTMLElement>('[class*="title"]')!
    titleSpan.textContent = 'Renamed'
    const renamedState: SessionArchiveState = {
      sessions: { byId: byId(summary('u', 'Renamed')) },
      workspaces,
    }
    expect(reconcileSessionArchiveRows(document.body, renamedState, archive, always)).toBe(1)
    // The icon stays (still resolvable to the same id) but its label refreshes.
    const icon = unique.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)!
    expect(icon.getAttribute('aria-label')).toBe('Archive session Renamed')

    // … and disappears once the title matches nothing at all.
    const ghostState: SessionArchiveState = { sessions: { byId: byId(summary('u', 'Other')) }, workspaces }
    expect(reconcileSessionArchiveRows(document.body, ghostState, archive, always)).toBe(1)
    expect(unique.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).toBeNull()
  })

  it('rebinds the id when a reused row element now resolves to another session', () => {
    const shared = row('Title A')
    document.body.appendChild(shared)
    const archive = vi.fn(async () => {})
    // First render: this element is session A.
    let state: SessionArchiveState = {
      sessions: { byId: byId(summary('a', 'Title A')) },
      workspaces: { items: [] },
    }
    expect(reconcileSessionArchiveRows(document.body, state, archive, always)).toBe(1)
    expect(shared.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)?.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('a')
    // React reuses the element for a different session that shares the title.
    state = { sessions: { byId: byId(summary('b', 'Title A')) }, workspaces: { items: [] } }
    expect(reconcileSessionArchiveRows(document.body, state, archive, always)).toBe(1)
    expect(shared.querySelector<HTMLElement>(`[${SESSION_ARCHIVE_ATTR}]`)?.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('b')
  })

  it('removes every icon when the feature is disabled', () => {
    const unique = row('Unique')
    document.body.appendChild(unique)
    const { sessions, workspaces } = states([summary('u', 'Unique')], { workspaceId: 'w1', title: 'Workspace', sessionIds: ['u'] })
    const state: SessionArchiveState = { sessions, workspaces }
    const archive = vi.fn(async () => {})
    expect(reconcileSessionArchiveRows(document.body, state, archive, always)).toBe(1)
    expect(reconcileSessionArchiveRows(document.body, state, archive, () => false)).toBe(1)
    expect(document.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).toBeNull()
  })
})

describe('createArchiveButton', () => {
  it('labels the button with the session name and archives on click', () => {
    const archive = vi.fn(async () => {})
    const button = createArchiveButton('s1', 'Ship it', archive)
    expect(button.getAttribute(SESSION_ARCHIVE_ID_ATTR)).toBe('s1')
    expect(button.getAttribute('aria-label')).toBe('Archive session Ship it')

    const parent = document.createElement('div')
    const onParentClick = vi.fn()
    parent.addEventListener('click', onParentClick)
    parent.appendChild(button)
    document.body.appendChild(parent)

    button.click()
    expect(archive).toHaveBeenCalledWith('s1')
    // A row click would open the session — the icon must not bubble.
    expect(onParentClick).not.toHaveBeenCalled()
  })
})

describe('dropRowIcon', () => {
  it('removes an injected icon and reports the change', () => {
    const unique = row('Unique')
    document.body.appendChild(unique)
    unique.appendChild(createArchiveButton('u', 'Unique', vi.fn(async () => {})))
    expect(dropRowIcon(unique)).toBe(true)
    expect(unique.querySelector(`[${SESSION_ARCHIVE_ATTR}]`)).toBeNull()
    expect(dropRowIcon(unique)).toBe(false)
  })
})
