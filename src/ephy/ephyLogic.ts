/* Ephy decisions that need no DOM and no bridge: the wording of prompts and
   the dirty-flag rules. Port of the pure parts of InkwellMac `Ephy` (Ephy.swift),
   translated for Windows (Ctrl+Z, "on disk"). */

/** "v7", or words when the CLI did not say. */
export const versionLabel = (version: number | undefined): string =>
  version === undefined ? 'an unknown version' : `v${version}`

/** A title safe for a note name: one line, no leading dashes, capped (Mac
    `Ephy.cleanTitle`, which main applies again before any argument). */
export function cleanTitle(title: string): string {
  const oneLine = title.split(/\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c]/).join(' ')
  let trimmed = oneLine.replace(/^[ \t]+|[ \t]+$/g, '')
  while (trimmed.startsWith('-')) trimmed = trimmed.slice(1)
  trimmed = trimmed.replace(/^[ \t]+|[ \t]+$/g, '')
  return trimmed.length === 0 ? 'Untitled note' : Array.from(trimmed).slice(0, 200).join('')
}

/** The sidebar name of an Ephy note (Mac `EphyController.name`). */
export const noteName = (title: string): string => `${cleanTitle(title)}.md`

/** The document id of an Ephy note. */
export const noteId = (artifactId: string): string => `ephy:${artifactId}`

/** Whether a note is still dirty after a Save to Ephy. An Ephy note lives only
    on Ephy, so it is clean if nobody typed during the upload. A local file is
    saved only by a disk save, so its flag does not change. */
export function dirtyAfterPublish(args: { ephyOnly: boolean; isDirty: boolean; sentRevision: number; currentRevision: number }): boolean {
  return args.ephyOnly ? args.currentRevision !== args.sentRevision : args.isDirty
}

/** The note already has what Ephy has: same known version. */
export const isUpToDate = (stored: number | undefined, fetched: number | undefined): boolean =>
  stored !== undefined && stored === fetched

/** The dialog that asks before Get Latest replaces a note's text. */
export function getLatestPrompt(args: { have: number | undefined; next: number | undefined; unsavedEdits: boolean; localFile: boolean }): { message: string; detail: string } {
  const message = args.next === undefined
    ? `Replace this note with the latest on Ephy? (You have ${versionLabel(args.have)}.)`
    : `Replace this note with Ephy ${versionLabel(args.next)}? (You have ${versionLabel(args.have)}.)`
  /* Unlike the Mac, Undo cannot bring the old text back: the note's undo
     history is cleared, because the stored version has moved on with it. */
  let detail = args.unsavedEdits
    ? 'Your unsaved edits will be replaced. This cannot be undone.'
    : 'The current text will be replaced. This cannot be undone.'
  if (args.localFile) detail += ' The file on disk does not change until you save it.'
  return { message, detail }
}

/** Whether a note is dirty after Get Latest replaced its text. An Ephy note
    now matches Ephy. A local file differs from its disk copy, so it stays
    unsaved until the user saves. */
export function dirtyAfterGetLatest(args: { ephyOnly: boolean; wasDirty: boolean; textChanged: boolean }): boolean {
  return args.ephyOnly ? false : args.wasDirty || args.textChanged
}

/** The picker's filter: title or id contains the trimmed, lowercased query. */
export function filterArtifacts<T extends { id: string; title: string }>(artifacts: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return artifacts
  return artifacts.filter((artifact) => artifact.title.toLowerCase().includes(needle) || artifact.id.toLowerCase().includes(needle))
}

/** "3 minutes ago" for the picker rows; empty when the time is unknown. */
export function relativeTime(updatedAt: number | undefined, now: number = Date.now()): string {
  if (updatedAt === undefined) return ''
  const seconds = Math.round((now - updatedAt) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]]
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(-Math.round(seconds / size), unit)
  }
  return 'just now'
}
