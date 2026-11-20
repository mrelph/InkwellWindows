import type { EphyArtifact, EphyDocument, EphyErrorCode } from '../ipc/contract'

/* The logic of the Ephy integration with no process and no Electron in it:
   id and title rules, what the `ephy` CLI prints, and what its failures mean.
   Port of InkwellMac Sources/InkwellCore/Ephy.swift (the `Ephy` enum and
   `EphyError`). Ephy notes are Amazon content: nothing here logs or stores
   them. */

export const TEXT_FORMATS: ReadonlySet<string> = new Set(['MARKDOWN', 'TEXT'])
export const DEFAULT_TIMEOUT_MS = 30_000
export const PAGE_SIZE = 100
export const MAX_LIST_LIMIT = 1000

/** A failure with a code the renderer can branch on and plain words for a person. */
export class EphyError extends Error {
  readonly code: EphyErrorCode

  constructor(code: EphyErrorCode, detail?: string) {
    super(detail && detail.length > 0 ? detail : defaultMessage(code))
    this.name = 'EphyError'
    this.code = code
  }

  /** The alert for this error has a Get Latest button (Mac `offersGetLatest`). */
  get offersGetLatest(): boolean {
    return this.code === 'conflict'
  }
}

/** Mac `EphyError.message`, with "Terminal" made neutral for Windows. */
export function defaultMessage(code: EphyErrorCode): string {
  switch (code) {
    case 'disabled': return 'Ephy is turned off. Turn it on in Integrations ▸ Ephy.'
    case 'notFound': return 'Ephy CLI not found. Install it with `toolbox install ephy`, then try again.'
    case 'signedOut': return 'Ephy needs you to sign in. Run `mwinit` in a terminal, then try again.'
    case 'timedOut': return 'Ephy took too long to answer. Try again.'
    case 'conflict': return 'Someone published a newer version on Ephy since you opened this note. Your edits are still here, unsaved.'
    case 'unavailable': return 'That Ephy artifact is gone, or you can no longer edit it.'
    case 'unsupported': return 'Inkwell opens Markdown and text artifacts only.'
    case 'invalidId': return "That isn't a valid Ephy artifact id."
    case 'badOutput': return "Ephy answered in a way Inkwell didn't understand."
    case 'notImplemented': return 'Ephy is not available in this build.'
    case 'failed': return "Ephy couldn't do that."
  }
}

/** Artifact ids are short and alphanumeric (`aB3dK9xQ2mZp`). Anything else,
    including a leading `-` that the CLI could read as a flag, is refused. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9]{6,40}$/.test(id)
}

/** A title safe to pass as one argument: one line, no leading dashes, capped. */
export function cleanTitle(title: string): string {
  const oneLine = title.split(/\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c]/).join(' ')
  let trimmed = oneLine.replace(/^[ \t]+|[ \t]+$/g, '')
  while (trimmed.startsWith('-')) trimmed = trimmed.slice(1)
  trimmed = trimmed.replace(/^[ \t]+|[ \t]+$/g, '')
  return trimmed.length === 0 ? 'Untitled note' : Array.from(trimmed).slice(0, 200).join('')
}

/* ---------------------------------------------------------------------- */
/* Parsing                                                                  */
/* ---------------------------------------------------------------------- */

type Json = unknown
type Row = Record<string, unknown>

const isRow = (value: Json): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)

function object(text: string): Json {
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new EphyError('badOutput')
  }
}

function int(value: Json): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10)
  return undefined
}

function titleOf(row: Row, fallback: string): string {
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  return title.length === 0 ? fallback : title
}

/** Epoch seconds, epoch milliseconds, or ISO 8601 with up to nine fractional
    digits (the CLI prints both forms in different commands). Returns epoch
    milliseconds. */
export function parseDate(value: Json): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Math.round(value > 100_000_000_000 ? value : value * 1000)
  }
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\.(\d+)/, (_all, digits: string) => `.${digits.slice(0, 3).padEnd(3, '0')}`)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

/** `post list --json` prints `{"artifacts": [...]}`. Sites and non-text
    formats are dropped, and so is any row whose id fails `isValidId`.
    `rawCount` is the number of rows before filtering, so the caller can tell
    whether asking for more might return more. */
export function parseList(text: string): { artifacts: EphyArtifact[]; rawCount: number } {
  const root = object(text)
  let rows: Json[]
  if (Array.isArray(root)) {
    rows = root
  } else if (isRow(root) && Array.isArray(root.artifacts ?? root.items ?? root.resources)) {
    rows = (root.artifacts ?? root.items ?? root.resources) as Json[]
  } else {
    throw new EphyError('badOutput')
  }
  const artifacts: EphyArtifact[] = []
  for (const row of rows) {
    if (!isRow(row)) continue
    const id = row.postId ?? row.id
    if (!isValidId(id)) continue
    const kind = typeof row.kind === 'string' ? row.kind.toLowerCase() : 'artifact'
    const format = typeof row.format === 'string' ? row.format.toUpperCase() : ''
    if (kind !== 'artifact' || !TEXT_FORMATS.has(format)) continue
    const updatedAt = parseDate(row.updatedAt ?? row.createdAt)
    artifacts.push({ id, title: titleOf(row, id), format, ...(updatedAt === undefined ? {} : { updatedAt }) })
  }
  return { artifacts, rawCount: rows.length }
}

/** A text artifact read with `post get <id> --json`. */
export function parseDocument(text: string): EphyDocument {
  const row = object(text)
  if (!isRow(row) || !isValidId(row.postId)) throw new EphyError('badOutput')
  const kind = typeof row.kind === 'string' ? row.kind.toLowerCase() : 'artifact'
  const format = typeof row.format === 'string' ? row.format.toUpperCase() : ''
  if (kind !== 'artifact' || !TEXT_FORMATS.has(format)) throw new EphyError('unsupported')
  if (typeof row.content !== 'string') throw new EphyError('badOutput')
  const version = int(row.version)
  return {
    id: row.postId,
    title: titleOf(row, row.postId),
    format,
    ...(version === undefined ? {} : { version }),
    content: row.content
  }
}

/** `artifact update --json` and `artifact new --json` both report the version
    they made. "No change" (plain text) yields nothing. */
export function parsePublished(text: string): { id?: string; version?: number } {
  let row: Json
  try {
    row = JSON.parse(text) as Json
  } catch {
    return {}
  }
  if (!isRow(row)) return {}
  const id = row.postId ?? row.id
  const version = int(row.version)
  return { ...(isValidId(id) ? { id } : {}), ...(version === undefined ? {} : { version }) }
}

/** `post open --json` prints `{"viewerUrl": "https://…"}`. Only https passes. */
export function parseViewerUrl(text: string): string | null {
  let candidate: string | undefined
  try {
    const row = JSON.parse(text) as Json
    if (isRow(row)) {
      const url = row.viewerUrl ?? row.url
      candidate = typeof url === 'string' ? url : undefined
    } else {
      candidate = undefined
    }
  } catch {
    candidate = text.trim()
  }
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.hostname === '') return null
    return url.href
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------- */
/* Failures                                                                 */
/* ---------------------------------------------------------------------- */

/** Plain words for a failed run. Signed out and expired Midway sessions
    become `signedOut` (the UI says "Run mwinit"); the rest keep the CLI's
    first line. */
export function classify(status: number, stderr: string): EphyError {
  const lower = stderr.toLowerCase()
  const midway = ['mwinit', 'midway', 'not signed in', 'sign in', 'signed out', 'unauthorized', 'unauthenticated', 'status 401', 'session expired', 'credentials expired', 'token expired']
  if (midway.some((needle) => lower.includes(needle))) return new EphyError('signedOut')
  if (['base-version', 'base version', 'newer version', 'conflict'].some((needle) => lower.includes(needle))) {
    return new EphyError('conflict')
  }
  // The CLI prints "error: not found (404): Artifact or site not found: <id>".
  const gone = ['(404)', '(403)', 'not found', 'forbidden', 'permission denied', 'no permission', 'access denied']
  if (gone.some((needle) => lower.includes(needle))) return new EphyError('unavailable')
  const lines = stderr.split(/\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c]/).map((line) => line.trim()).filter((line) => line.length > 0)
  // The CLI prints "info:" and "warning:" notes before the real error.
  // Skip them, so the message shows why the command failed.
  const notes = ['info:', 'warning:', 'warn:', 'note:']
  const isNote = (line: string) => notes.some((prefix) => line.toLowerCase().startsWith(prefix))
  const reason = lines.find((line) => !isNote(line))
  if (reason !== undefined) return new EphyError('failed', reason.slice(0, 200))
  if (lines.length > 0) return new EphyError('failed', `${lines[0]} (exit ${status})`.slice(0, 200))
  return new EphyError('failed', `Ephy couldn't do that (exit ${status}).`)
}
