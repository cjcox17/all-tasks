/**
 * Title synthesis for the task board: the pure helpers behind auto-generated
 * task titles. The Host's title-suggestion session (a short backend LLM turn
 * over the run prompt) produces the primary title; these helpers derive the
 * deterministic no-LLM fallback (the prompt's first meaningful line) and
 * sanitize whatever the generation session returns. Framework-free so the
 * whole surface is unit-testable in isolation, exactly like the other core
 * transitions.
 */

/** Maximum characters of a task title (display cap). */
export const TITLE_MAX_LENGTH = 80

/** Suffix appended when a title is truncated at the cap. */
const TITLE_ELLIPSIS = '…'

/** Collapse every run of whitespace into one space and trim. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Strip a leading markdown-ish list/quote/heading marker from a line. */
function stripLeadingMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|#+\s*|>\s*)\s*/, '').trim()
}

/** Cap a single-line title at {@link TITLE_MAX_LENGTH} with an ellipsis. */
function truncateTitle(line: string): string {
  if (line.length <= TITLE_MAX_LENGTH) return line
  return `${line.slice(0, TITLE_MAX_LENGTH - 1)}${TITLE_ELLIPSIS}`
}

/** The first non-blank, marker-stripped line of a text block, if any. */
function firstMeaningfulLine(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = collapseWhitespace(stripLeadingMarker(rawLine))
    if (line !== '') return line
  }
  return undefined
}

/**
 * The deterministic no-LLM title: the prompt's first meaningful line, falling
 * back to the description's, truncated to {@link TITLE_MAX_LENGTH}. Returns
 * the empty string when neither input carries a usable line, so callers can
 * still reject a fully blank task (the ledger requires a non-blank title).
 */
export function fallbackTitle(prompt: string, description: string): string {
  const line = firstMeaningfulLine(prompt) ?? firstMeaningfulLine(description)
  return line === undefined ? '' : truncateTitle(line)
}

/**
 * Normalize a generated title into the display form: drop surrounding code
 * fences, keep only the first line (the instruction asks for a single line,
 * but a model may wrap or annotate), strip surrounding quotes and leading
 * list markers, collapse whitespace, and cap the length. Returns undefined
 * when nothing usable remains (the caller falls back to
 * {@link fallbackTitle}).
 */
export function sanitizeGeneratedTitle(text: string): string | undefined {
  const raw = text.trim()
  if (raw === '') return undefined
  const unfenced = raw
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```[^\n]*$/, '')
    .trim()
  const firstLine = unfenced.split(/\r?\n/, 1)[0] ?? unfenced
  const unwrapped = firstLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  const cleaned = collapseWhitespace(stripLeadingMarker(unwrapped))
  if (cleaned === '') return undefined
  return truncateTitle(cleaned)
}

/**
 * The one-shot instruction sent to the title-generation session: reply with
 * exactly one short title line for the task, nothing else. The run prompt is
 * the title source of truth; the description (when present) adds context.
 */
export function titleInstruction(prompt: string, description: string): string {
  const taskText = description === ''
    ? prompt
    : `${prompt}\n\nTask description:\n${description}`
  return [
    'You are the title generator for a task board. Read the task prompt below and reply with ONLY the task title: a single short line, no quotes, no markdown, no explanation, at most 80 characters.',
    '',
    `Task prompt:\n${taskText}`,
    '',
    'Title:',
  ].join('\n')
}
