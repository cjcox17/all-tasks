/**
 * Group-banner status CSS guards: the Running/Pending pills must stay
 * compact, pill-shaped, and visible against the column background, with a
 * spinner that respects the reduced-motion preference (like the card
 * spinner). A regression here would silently hide the group's live status.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/board.module.css', import.meta.url), 'utf8')

describe('group banner status css', () => {
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
    expect(media).toMatch(/\.groupStatusSpinner\s*\{\s*animation: none;\s*\}/)
  })
})
