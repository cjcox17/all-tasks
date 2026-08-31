/**
 * Vendored into this standalone repo from the dsh-web monorepo
 * (zhu1090093659/dsh-web, `shared/web-platform.ts`) at the dsh-task-board
 * v0.3.6 fork point; kept as a plain source file here (no sync script in
 * this repo).
 *
 * Browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * Mirrors the shell's frozen module table (dsh-web-frontend staticModules,
 * verified against the 0.1.1-rc.2 dist: react, react/jsx-runtime, react-dom,
 * react-dom/client, cordis, dsh-client-ui-slots, dsh-client-ui-primitives;
 * the rc.2 dist carries the same set with no new frozen modules).
 * @module all-tasks/build/web-platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const
