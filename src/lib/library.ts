import { fileIdFor, isInside, pathKey } from './paths'

/* The library model: documents, sources, and the groups the sidebar shows.
   DOM-free so it can be tested. Mac reference: AppModel.swift. */

/* The groups that are not folders. Drafts are notes with no file yet, Ephy
   notes live only in memory (never in library.json, never in Recent), and
   recent is everything opened from outside an added folder. */
export const DRAFTS = 'drafts'
export const EPHY = 'ephy'
export const RECENT = 'recent'

/** The Ephy artifact an in-memory Ephy note was opened from. */
export type EphyNoteMeta = { id: string; title: string; version?: number }

export type MarkdownDoc = {
  id: string
  name: string
  content: string
  path?: string
  /** Which group in the library this belongs to: a folder id, DRAFTS, EPHY or RECENT. */
  sourceId: string
  isDirty?: boolean
  /** mtime Inkwell last saw on disk, used to detect an external edit. */
  savedAt?: number
  /** Bumped on every edit, so an async save can tell whether typing continued
      while it ran (Mac `MarkdownDoc.revision`). */
  revision?: number
  /** Set on Ephy notes (sourceId EPHY). */
  ephy?: EphyNoteMeta
}

/** A folder the user added to the library. Folders are sources, not
    workspaces: adding one never displaces another. */
export type FolderSource = { id: string; name: string; path: string }

export type LibraryKind = 'folder' | 'drafts' | 'ephy' | 'recent'

/* A row is what the pane shows, which is not the same as a document: a recent
   file that is not open has a path and a name but no content behind it yet. */
export type LibraryRow = {
  key: string
  name: string
  path?: string
  doc?: MarkdownDoc
  kind: LibraryKind
  meta: string
}

export type LibraryGroup = {
  id: string
  name: string
  kind: LibraryKind
  path?: string
  rows: LibraryRow[]
}

export const toDoc = (file: DocumentFile, sourceId: string): MarkdownDoc => ({
  id: fileIdFor(file.path),
  name: file.name,
  path: file.path,
  content: file.content,
  savedAt: file.savedAt,
  sourceId
})

/** A file inside an added folder belongs to that folder's group, wherever it
    was opened from. Everything else is recent. */
export const sourceForPath = (folders: FolderSource[], filePath: string) =>
  folders.find((folder) => isInside(filePath, folder.path))?.id ?? RECENT

export const kindForSource = (sourceId: string): LibraryKind =>
  sourceId === DRAFTS ? 'drafts' : sourceId === EPHY ? 'ephy' : sourceId === RECENT ? 'recent' : 'folder'

export const rowFor = (doc: MarkdownDoc, kind: LibraryKind = kindForSource(doc.sourceId)): LibraryRow => ({
  key: doc.id,
  name: doc.name,
  path: doc.path,
  doc,
  kind,
  meta: doc.path ? 'Local file' : doc.sourceId === EPHY ? 'Ephy' : 'Draft'
})

/** Only drafts, Ephy notes and recent files can be closed. Closing a file a
    folder source lists would be meaningless — the folder still holds it. */
export const isClosable = (row: LibraryRow | null | undefined): row is LibraryRow =>
  Boolean(row && row.kind !== 'folder')

export const rememberRecentEntries = (
  current: RecentEntry[],
  files: { path: string; name: string }[],
  openedAt: number,
  max: number
) => {
  const fresh = files.map((file) => ({ path: file.path, name: file.name, openedAt }))
  const rest = current.filter((entry) => !fresh.some((item) => pathKey(item.path) === pathKey(entry.path)))
  return [...fresh, ...rest].slice(0, max)
}

/* A restore that finishes after the user already did something must merge,
   never replace (Mac `pendingOpens`): a folder added while library.json was
   being read keeps its place after the restored ones (the fixed order: the
   order folders were added), and a file opened meanwhile stays at the top of
   Recent. Deduped by path key; overlapping folders are dropped, as Add Folder
   would refuse them; both lists keep their caps. */
export const mergeRestoredFolders = (restored: FolderSource[], current: FolderSource[], max: number): FolderSource[] => {
  const merged: FolderSource[] = []
  const overlaps = (a: string, b: string) => isInside(a, b) || isInside(b, a)
  for (const folder of [...restored, ...current]) {
    if (merged.some((entry) => overlaps(entry.path, folder.path))) continue
    merged.push(folder)
  }
  return merged.slice(0, max)
}

export const mergeRestoredRecent = (restored: RecentEntry[], current: RecentEntry[], max: number): RecentEntry[] => {
  const merged: RecentEntry[] = []
  for (const entry of [...current, ...restored]) {
    if (merged.some((item) => pathKey(item.path) === pathKey(entry.path))) continue
    merged.push(entry)
  }
  return merged.slice(0, max)
}

/** Documents opened ad hoc (Recent) that live in a folder source belong to it. */
export const adoptIntoFolders = (documents: MarkdownDoc[], folders: FolderSource[]): MarkdownDoc[] =>
  documents.map((doc) => {
    if (!doc.path || doc.sourceId !== RECENT) return doc
    const folder = folders.find((source) => isInside(doc.path as string, source.path))
    return folder ? { ...doc, sourceId: folder.id } : doc
  })

/* One group per source, in a fixed order (Mac order): the folders you chose,
   then drafts that have nowhere to live yet, then Ephy notes, then recent
   files. A search drops empty groups. */
export function buildGroups({ documents, folders, recent, query }: {
  documents: MarkdownDoc[]
  folders: FolderSource[]
  recent: RecentEntry[]
  query: string
}): LibraryGroup[] {
  const normalized = query.trim().toLowerCase()
  const matchesDoc = (doc: MarkdownDoc) => !normalized || `${doc.name} ${doc.content}`.toLowerCase().includes(normalized)
  const matchesName = (name: string) => !normalized || name.toLowerCase().includes(normalized)

  const list: LibraryGroup[] = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    kind: 'folder' as const,
    path: folder.path,
    rows: documents
      .filter((doc) => doc.sourceId === folder.id && matchesDoc(doc))
      .sort((first, second) => first.name.localeCompare(second.name))
      .map((doc) => rowFor(doc, 'folder'))
  }))

  const drafts = documents.filter((doc) => doc.sourceId === DRAFTS && matchesDoc(doc)).map((doc) => rowFor(doc, 'drafts'))
  if (drafts.length) list.push({ id: DRAFTS, name: 'Drafts', kind: 'drafts', rows: drafts })

  const ephy = documents.filter((doc) => doc.sourceId === EPHY && matchesDoc(doc)).map((doc) => rowFor(doc, 'ephy'))
  if (ephy.length) list.push({ id: EPHY, name: 'Ephy', kind: 'ephy', rows: ephy })

  /* Recent holds two kinds of row: files open in this session, and files
     remembered from an earlier one that have not been read back yet. A file
     inside an added folder is listed there instead of twice. */
  const seen = new Set<string>()
  const recentRows: LibraryRow[] = []
  documents.filter((doc) => doc.sourceId === RECENT).forEach((doc) => {
    if (doc.path) seen.add(pathKey(doc.path))
    if (matchesDoc(doc)) recentRows.push(rowFor(doc, 'recent'))
  })
  recent.forEach((entry) => {
    if (seen.has(pathKey(entry.path))) return
    if (folders.some((folder) => isInside(entry.path, folder.path))) return
    seen.add(pathKey(entry.path))
    if (matchesName(entry.name)) {
      recentRows.push({ key: `recent:${entry.path}`, name: entry.name, path: entry.path, kind: 'recent', meta: 'Not open' })
    }
  })
  if (recentRows.length) list.push({ id: RECENT, name: 'Recent', kind: 'recent', rows: recentRows })

  return normalized ? list.filter((group) => group.rows.length) : list
}
