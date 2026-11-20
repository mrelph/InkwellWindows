import nodePath from 'node:path'
import { isMarkdown } from './fileStore'
import {
  broadFolderReason,
  isLexicallyInside,
  isPlainAbsolute,
  networkAllowed,
  pathKey,
  type PathFlavour
} from './pathRules'

/* Main's authority over which paths the renderer may name. The renderer is
   treated as potentially compromised, so every path it sends is checked here,
   LEXICALLY (no fs call; see pathRules.ts), against what main itself handed
   out. Separate records, because they grant different things:

   1. WRITABLE documents (read, save, rename, duplicate, trash): a Markdown
      file main opened through a dialog, got on argv / from a second
      instance, found by walking a library folder it trusts, saved through a
      Save dialog, or produced by its own rename / duplicate. The ones that
      did not come from a library walk persist across launches in a file only
      main writes (`trusted-documents.json`), so a Recent file stays writable
      next time; library.json, which the renderer writes, never grants this.
   2. READABLE documents (read only): a Markdown file reached through a reader
      link from a trusted note, and the Recent files / last active note
      library.json held at startup. Saving one goes through a Save dialog.
   3. NOTE FOLDERS (asset roots): the parent folder of each document above.
      The asset scheme accepts one as `r` only for images on a network share
      (local images load anywhere, as on the Mac).
   4. LIBRARY FOLDERS: folders the user chose in the Add Folder dialog, or that
      were in library.json when main loaded it at startup. Never a drive root,
      the home folder or a folder holding it. `state:save` from the renderer
      can REMOVE one but never ADD one main does not know. A Markdown file
      lexically inside one is readable.

   No Electron imports, so it is unit tested. Paths compare resolved and, on
   Windows, case-insensitively. Each record is bounded; the oldest entry is
   forgotten first and one that is used again moves to the back. */

export const MAX_TRUSTED_FOLDERS = 2000
export const MAX_TRUSTED_DOCUMENTS = 20_000
export const MAX_PERSISTED_DOCUMENTS = 500
export const MAX_LIBRARY_FOLDERS = 8

type Bounded = Map<string, string>

const remember = (map: Bounded, key: string, value: string, limit: number) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Resolved folder by comparison key, oldest first. */
const folders: Bounded = new Map()
/** Writable documents: resolved path by comparison key, oldest first. */
const documents: Bounded = new Map()
/** The writable documents that persist (not found by a library walk). */
const persisted: Bounded = new Map()
/** Read-only documents (reader-link targets, library.json's Recent). */
const readable: Bounded = new Map()
let onPersistedChange: (() => void) | null = null
/** Every library folder main has vouched for this session (startup + dialog). */
const knownLibrary: Bounded = new Map()
/** The library as it stands now: known folders the renderer still lists. */
let activeLibrary: string[] = []
let home = ''

/* ------------------------------------------------------------------------ */
/* Documents and their folders                                               */
/* ------------------------------------------------------------------------ */

/** Records a document main handed out: it may now be read and written, and
    its folder counts as a note folder for the asset scheme. `persist` keeps
    it writable across launches (everything except a library walk). */
export function trustDocument(filePath: unknown, pathApi: PathFlavour = nodePath, options: { persist?: boolean } = {}): void {
  if (!isPlainAbsolute(filePath, pathApi)) return
  const resolved = pathApi.resolve(filePath)
  trustNoteFolder(resolved, pathApi)
  if (!isMarkdown(resolved)) return
  const key = pathKey(resolved, pathApi)
  remember(documents, key, resolved, MAX_TRUSTED_DOCUMENTS)
  readable.delete(key)
  if (options.persist) {
    remember(persisted, key, resolved, MAX_PERSISTED_DOCUMENTS)
    onPersistedChange?.()
  }
}

/** A read-only document: a reader-link target, or a Recent entry from
    library.json. Never upgrades or downgrades a writable one. */
export function trustReadableDocument(filePath: unknown, pathApi: PathFlavour = nodePath): void {
  if (!isPlainAbsolute(filePath, pathApi) || !isMarkdown(filePath)) return
  const resolved = pathApi.resolve(filePath)
  trustNoteFolder(resolved, pathApi)
  const key = pathKey(resolved, pathApi)
  if (!documents.has(key)) remember(readable, key, resolved, MAX_TRUSTED_DOCUMENTS)
}

/** Records only the folder of a document main read (for network images). */
export function trustNoteFolder(filePath: string, pathApi: PathFlavour = nodePath): void {
  if (!isPlainAbsolute(filePath, pathApi)) return
  const folder = pathApi.dirname(pathApi.resolve(filePath))
  remember(folders, pathKey(folder, pathApi), folder, MAX_TRUSTED_FOLDERS)
}

export function trustDocuments(
  files: ReadonlyArray<{ path: string } | null | undefined>,
  pathApi: PathFlavour = nodePath,
  options: { persist?: boolean } = {}
): void {
  for (const file of files) if (file) trustDocument(file.path, pathApi, options)
}

/** A document that has gone (renamed away, trashed) stops being writable. */
export function forgetDocument(filePath: unknown, pathApi: PathFlavour = nodePath): void {
  if (!isPlainAbsolute(filePath, pathApi)) return
  const key = pathKey(filePath, pathApi)
  documents.delete(key)
  readable.delete(key)
  if (persisted.delete(key)) onPersistedChange?.()
}

/** The writable documents to keep for the next launch, oldest first. */
export function persistedDocuments(): string[] {
  return [...persisted.values()]
}

/** Startup: the documents main itself persisted last time. */
export function restorePersistedDocuments(paths: unknown, pathApi: PathFlavour = nodePath): void {
  const list = Array.isArray(paths) ? paths.slice(-MAX_PERSISTED_DOCUMENTS) : []
  const listener = onPersistedChange
  onPersistedChange = null
  for (const entry of list) trustDocument(entry, pathApi, { persist: true })
  onPersistedChange = listener
}

/** Called whenever the persisted set changes (documents.ts saves it). */
export function onPersistedDocumentsChange(listener: (() => void) | null): void {
  onPersistedChange = listener
}

/** Whether `filePath` is exactly a document main handed out. Lexical. */
export function isTrustedDocument(filePath: unknown, pathApi: PathFlavour = nodePath): filePath is string {
  if (!isPlainAbsolute(filePath, pathApi) || !isMarkdown(filePath)) return false
  return documents.has(pathKey(filePath, pathApi))
}

/** Whether `folder` is the parent directory of a document main vouched for. */
export function isTrustedNoteFolder(folder: string, pathApi: PathFlavour = nodePath): boolean {
  if (!isPlainAbsolute(folder, pathApi)) return false
  return folders.has(pathKey(folder, pathApi))
}

/** May the renderer WRITE here (save, rename, trash)? Only a Markdown file
    main itself handed out. */
export function mayWriteDocument(filePath: unknown, pathApi: PathFlavour = nodePath): filePath is string {
  return isTrustedDocument(filePath, pathApi)
}

/** May the renderer READ this path (`document:read`)? A writable or readable
    document, or a Markdown file lexically inside a library folder (a network
    path only inside a network library folder). Lexical: no fs call. */
export function mayReadDocument(filePath: unknown, pathApi: PathFlavour = nodePath): filePath is string {
  if (!isPlainAbsolute(filePath, pathApi) || !isMarkdown(filePath)) return false
  if (isTrustedDocument(filePath, pathApi) || readable.has(pathKey(filePath, pathApi))) return true
  if (!networkAllowed(filePath, activeLibrary, pathApi)) return false
  return activeLibrary.some((folder) => isLexicallyInside(filePath, folder, pathApi))
}

/** Paths the renderer may hand to "reveal in file manager": readable
    documents only. Explorer would otherwise contact any server named. */
export const mayRevealPath = mayReadDocument

/* ------------------------------------------------------------------------ */
/* Library folders                                                           */
/* ------------------------------------------------------------------------ */

/** The home folder broad-folder refusal compares against. Set once at startup. */
export function setHomeFolder(folder: string): void {
  home = folder
}

export type LibraryVerdict = { ok: true; folder: string } | { ok: false; reason: string }

/** Whether `folder` could be a library folder at all (absolute, not too broad). */
export function checkLibraryFolder(folder: unknown, pathApi: PathFlavour = nodePath): LibraryVerdict {
  if (!isPlainAbsolute(folder, pathApi)) return { ok: false, reason: 'That is not a folder Inkwell can use' }
  const resolved = pathApi.resolve(folder)
  const broad = broadFolderReason(resolved, home, pathApi)
  return broad ? { ok: false, reason: broad } : { ok: true, folder: resolved }
}

/** A folder the user chose in the Add Folder dialog, or one library.json held
    at startup: known from now on, and active immediately (so its images and
    notes are allowed before the renderer's debounced state save lands). */
export function trustLibraryFolder(folder: unknown, pathApi: PathFlavour = nodePath): LibraryVerdict {
  const verdict = checkLibraryFolder(folder, pathApi)
  if (!verdict.ok) return verdict
  const key = pathKey(verdict.folder, pathApi)
  remember(knownLibrary, key, verdict.folder, 64)
  if (!activeLibrary.some((entry) => pathKey(entry, pathApi) === key)) {
    activeLibrary = [...activeLibrary, verdict.folder].slice(-MAX_LIBRARY_FOLDERS)
  }
  return verdict
}

export function isKnownLibraryFolder(folder: unknown, pathApi: PathFlavour = nodePath): folder is string {
  if (!isPlainAbsolute(folder, pathApi)) return false
  return knownLibrary.has(pathKey(folder, pathApi))
}

/** The renderer's library list, reduced to folders main knows. The result
    becomes the active library: the renderer can drop a folder, never add one.
    Returns the folders kept, in the renderer's order, spelled as main knows
    them. */
export function retainLibraryFolders(next: unknown, pathApi: PathFlavour = nodePath): string[] {
  const list = Array.isArray(next) ? next : []
  const kept: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isKnownLibraryFolder(entry, pathApi)) continue
    const key = pathKey(entry, pathApi)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(knownLibrary.get(key) ?? pathApi.resolve(entry))
    if (kept.length >= MAX_LIBRARY_FOLDERS) break
  }
  activeLibrary = kept
  return kept
}

/** The library folders as main currently trusts them. */
export function libraryFolders(): string[] {
  return [...activeLibrary]
}

/** Startup: what library.json held when main loaded it. Folders become known
    library folders (broad ones are refused); the Recent files and the last
    active note become READABLE (writable only if main persisted them itself).
    Lexical only; returns the folders accepted. */
export function trustStoredLibrary(state: { folders?: unknown; recent?: unknown; activePath?: unknown }, pathApi: PathFlavour = nodePath): string[] {
  const accepted: string[] = []
  for (const folder of Array.isArray(state.folders) ? state.folders : []) {
    const verdict = trustLibraryFolder(folder, pathApi)
    if (verdict.ok) accepted.push(verdict.folder)
  }
  for (const entry of Array.isArray(state.recent) ? state.recent : []) {
    const recentPath = typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined
    trustReadableDocument(recentPath, pathApi)
  }
  trustReadableDocument(state.activePath, pathApi)
  return accepted
}

/** For tests. */
export function forgetTrustedDocuments(): void {
  folders.clear()
  documents.clear()
  persisted.clear()
  readable.clear()
  knownLibrary.clear()
  activeLibrary = []
  home = ''
}
