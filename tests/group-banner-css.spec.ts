/**
 * Group-banner CSS guards: the banner must stay a self-contained block —
 * its header wraps so the trailing action buttons (notably the Manage gear)
 * never overflow the dashed group box on a narrow column — and the
 * Running/Pending pills stay compact, pill-shaped, and visible against the
 * column background, with a spinner that respects the reduced-motion
 * preference (like the card spinner). A regression here would silently hide
 * the group's live status or push its controls outside the group box.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')

describe('group banner css', () => {
  it('wraps the header so banner controls stay inside the group box', () => {
    const header = css.match(/\.groupHeader\s*\{([^}]*)\}/)?.[1] ?? ''
    // The grid's narrowest column (220px) cannot hold name + mode badge +
    // status pills + count + four action buttons on one line; without
    // wrapping the trailing Manage gear overflows the group section and
    // paints outside the dashed box (regression: gear rendered outside).
    expect(header).toContain('flex-wrap: wrap')
    // No horizontal scrollbar trap inside the header either.
    expect(header).not.toContain('overflow-x: auto')
    expect(header).not.toContain('overflow-x: scroll')
  })

  it('renders the status pills as a compact rounded pill', () => {
    const block = css.match(/\.groupStatus\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toContain('border-radius: 999px')
    expect(block).toContain('display: inline-flex')
    expect(block).toContain('font-size: 11px')
    expect(block).toContain('white-space: nowrap')
  })

  it('colors the Running pill with the warning state and the Pending pill with the business state', () => {
    const running = css.match(/\.groupStatus\[data-kind='running'\]\s*\{([^}]*)\}/)?.[1] ?? ''
    const pending = css.match(/\.groupStatus\[data-kind='pending'\]\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(running).toContain('var(--dsw-alias-state-warn-primary)')
    expect(pending).toContain('var(--dsw-alias-state-business-primary)')
  })

  it('spins the Running pill spinner and stops it under reduced motion', () => {
    const spinner = css.match(/\.groupStatusSpinner\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(spinner).toContain('animation: dshTbSpin 800ms linear infinite')
    // Inside the reduced-motion media query the spinner animation is stripped.
    const media = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(media).toContain('.groupStatusSpinner')
    // The spinner is disabled inside a shared selector list with the card
    // spinner and the action-circle ring (all three animations are stripped).
    expect(media).toMatch(/\.groupStatusSpinner[\s\S]*?animation: none;\s*\}/)
  })
})
