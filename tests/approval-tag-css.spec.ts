/**
 * Unapproved-tag CSS guards: the unapproved pill (on a task card's meta row)
 * and the unapproved badge (in the workspace overview list) must render
 * high-contrast danger-red text on a light red tint so they stay legible.
 * Regressing them to the DSH warning palette yields light-pink text on a
 * bright orange pill — nearly unreadable ("can't be red"). These rules lock in
 * the error-state tokens and guard the pill geometry the meta row relies on.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')

describe('unapproved tag css', () => {
  it('renders the card unapproved pill with danger-red text on a light red tint', () => {
    const block = css.match(/\.cardUnapproved\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toContain('color: var(--dsw-alias-state-error-primary)')
    expect(block).toContain('background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)')
    expect(block).toContain('border: 1px solid var(--dsw-alias-state-error-primary)')
    // Only the color tokens changed; the pill keeps the same compact geometry.
    expect(block).toContain('font-size: 11px')
    expect(block).toContain('font-weight: 600')
    expect(block).toContain('border-radius: 999px')
    expect(block).toContain('padding: 1px 8px')
  })

  it('renders the workspace-list unapproved badge with the same danger palette', () => {
    const block = css.match(/\.taskBadge\[data-kind='unapproved'\]\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toContain('color: var(--dsw-alias-state-error-primary)')
    expect(block).toContain('background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)')
    expect(block).toContain('border: 1px solid var(--dsw-alias-state-error-primary)')
  })

  it('leaves the paused pill on the warning palette untouched', () => {
    const paused = css.match(/\.cardPaused\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(paused).toContain('color: var(--dsw-alias-state-warn-primary)')
    expect(paused).toContain('background: var(--dsw-alias-state-warn-secondary)')
  })

  it('keeps the warning palette out of the unapproved styles', () => {
    const card = css.match(/\.cardUnapproved\s*\{([^}]*)\}/)?.[1] ?? ''
    const badge = css.match(/\.taskBadge\[data-kind='unapproved'\]\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(card).not.toContain('warn')
    expect(badge).not.toContain('warn')
  })
})
