import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { decodeDocument, writeAtomically } from './fileStore'
import { MAX_EPHY_LINKS, READER_FONT_VALUES, type EphyLink, type InkwellState, type ReaderFont, type ViewMode } from './ipc/contract'

export type { InkwellState, RecentEntry, ReaderFont } from './ipc/contract'

/* `folders` are sources in the order the user added them. `ephyLinks` hold
   ids, titles and versions only — never note content. Older files also carry
   `introDone` from the sample documents, which are gone; unknown keys are
   simply dropped by sanitize. */
const EMPTY: InkwellState = {
  folders: [],
  recent: [],
  readerFont: 'editorial',
  zoomLevel: 100,
  view: 'split',
  ephyLinks: {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MAX_FOLDERS = 8
const MAX_RECENT = 12
/* All ten, including the five installed-only fonts (bookerly, ember, roboto,
   ubuntu, geist-mono): a choice whose font is missing is kept, so it works
   again once the font is installed (Mac behaviour). */
const READER_FONTS: readonly ReaderFont[] = READER_FONT_VALUES
const VIEWS: ViewMode[] = ['read', 'split', 'write']

/* Mirrors Ephy.isValidId on the Mac: short and alphanumeric, so nothing in the
   file can smuggle a flag (`-x`) into a CLI argument later. */
const isValidEphyId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9]{6,40}$/.test(id)

const cleanEphyTitle = (title: unknown) => {
  const oneLine = typeof title === 'string' ? title.replace(/[\r\n]+/g, ' ').trim().replace(/^-+/, '').trim() : ''
  return oneLine ? oneLine.slice(0, 200) : 'Untitled note'
}

const sanitizeEphyLinks = (value: unknown): Record<string, EphyLink> => {
  if (!isRecord(value)) return {}
  const links: Record<string, EphyLink> = {}
  for (const key of Object.keys(value).sort()) {
    if (Object.keys(links).length >= MAX_EPHY_LINKS) break
    if (!path.isAbsolute(key)) continue
    const entry = value[key]
    if (!isRecord(entry)) continue
    /* `artifactId` is the Mac file's spelling; accept either. */
    const id = entry.id ?? entry.artifactId
    if (!isValidEphyId(id)) continue
    const version = typeof entry.version === 'number' && Number.isInteger(entry.version) && entry.version >= 0
      ? entry.version
      : undefined
    links[key] = version === undefined
      ? { id, title: cleanEphyTitle(entry.title) }
      : { id, title: cleanEphyTitle(entry.title), version }
  }
  return links
}

const stateFile = () => path.join(app.getPath('userData'), 'library.json')

/* The state file is plain JSON in a directory the user can open and edit, and a
   half-written or hand-mangled one must never take the app down with it. Every
   field is validated rather than trusted, and anything unrecognised is dropped
   in favour of the default. */
const sanitize = (value: unknown): InkwellState => {
  if (!isRecord(value)) return EMPTY

  const folders = Array.isArray(value.folders)
    ? value.folders.filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry)).slice(0, MAX_FOLDERS)
    : []

  const recent = Array.isArray(value.recent)
    ? value.recent
        .filter(isRecord)
        .filter((entry) => typeof entry.path === 'string' && path.isAbsolute(entry.path as string))
        .map((entry) => ({
          path: entry.path as string,
          name: typeof entry.name === 'string' ? entry.name : path.basename(entry.path as string),
          openedAt: typeof entry.openedAt === 'number' ? entry.openedAt : 0
        }))
        .slice(0, MAX_RECENT)
    : []

  return {
    folders,
    recent,
    activePath: typeof value.activePath === 'string' ? value.activePath : undefined,
    readerFont: READER_FONTS.includes(value.readerFont as ReaderFont)
      ? value.readerFont as ReaderFont
      : 'editorial',
    zoomLevel: typeof value.zoomLevel === 'number' && Number.isFinite(value.zoomLevel)
      ? Math.min(140, Math.max(80, Math.round(value.zoomLevel / 10) * 10))
      : 100,
    view: VIEWS.includes(value.view as ViewMode) ? value.view as ViewMode : 'split',
    ephyLinks: sanitizeEphyLinks(value.ephyLinks)
  }
}

export async function loadState(): Promise<InkwellState> {
  try {
    return sanitize(JSON.parse(decodeDocument(await readFile(stateFile()))))
  } catch {
    /* No file yet, or an unreadable one: start clean rather than fail to open. */
    return EMPTY
  }
}

/* Written through a temporary file and renamed into place (with the Windows
   retry/fallback in `writeAtomically`): the renderer saves on every library
   change, so a crash mid-write would otherwise be able to leave a truncated
   file that loses the whole library rather than one edit. */
export async function saveState(next: unknown): Promise<void> {
  const target = stateFile()
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeAtomically(target, JSON.stringify(sanitize(next), null, 2))
  } catch {
    /* Persistence is a convenience; never surface it as a failure to the user. */
  }
}
