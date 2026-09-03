/**
 * React render of the official DSH "Archive session" glyph (see archive-icon.ts).
 * Sized by the consumer; color follows `currentColor`.
 */
import { ARCHIVE_ICON_NOTCH, ARCHIVE_ICON_PATH } from '../archive-icon.ts'

export function ArchiveIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={ARCHIVE_ICON_PATH} fill="currentColor" />
      <path d={ARCHIVE_ICON_NOTCH} fill="currentColor" />
    </svg>
  )
}
