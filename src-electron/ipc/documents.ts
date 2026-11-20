import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  decodeDocument,
  exists,
  isMarkdown,
  readMarkdownFileSafely,
  toFileName,
  uniqueCopyPath,
  walkMarkdownFiles,
  writeAtomically,
  type DocumentFile
} from '../fileStore'
import { handle, on } from '../ipcGuard'
import { isPlainAbsolute } from '../pathRules'
import { resolveNoteLink } from '../readerLinks'
import { loadState, saveState } from '../state'
import {
  checkLibraryFolder,
  forgetDocument,
  isKnownLibraryFolder,
  libraryFolders,
  mayReadDocument,
  mayRevealPath,
  mayWriteDocument,
  onPersistedDocumentsChange,
  persistedDocuments,
  restorePersistedDocuments,
  retainLibraryFolders,
  setHomeFolder,
  trustDocument,
  trustDocuments,
  trustLibraryFolder,
  trustNoteFolder,
  trustReadableDocument,
  trustStoredLibrary
} from '../trustedDocuments'
import type { FolderResult, InkwellState, LinkOpenResult, SavePayload, SaveResult } from './contract'

/* Document, file and library-state IPC. The renderer is treated as
   potentially compromised: every handler checks its sender (ipcGuard.ts),
   validates its payload, and asks trustedDocuments.ts — LEXICALLY, before
   any fs call — whether main ever handed out the path it names. A save to
   any other Markdown path goes through a Save dialog; anything that is not
   Markdown is refused. */

let registered = false

const MAX_NAME_TEXT = 2000
const EMPTY_FOLDER: FolderResult = { folder: '', documents: [] }

const trustFile = () => path.join(app.getPath('userData'), 'trusted-documents.json')

/* Main's own record of the writable documents that did not come from a
   library walk, so a Recent file is still writable next launch. Only main
   writes it; library.json (which the renderer writes) never grants this. */
let persistTimer: NodeJS.Timeout | null = null
function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    const target = trustFile()
    void mkdir(path.dirname(target), { recursive: true })
      .then(() => writeAtomically(target, JSON.stringify({ documents: persistedDocuments() }, null, 2)))
      .catch(() => undefined)
  }, 500)
}

let initialised: Promise<void> | null = null

/** Loads main's authority before the window exists: the documents it
    persisted, then what library.json holds (folders become known library
    folders, Recent files readable). Idempotent. */
export function initialiseDocumentTrust(): Promise<void> {
  initialised ??= (async () => {
    setHomeFolder(app.getPath('home'))
    try {
      const stored = JSON.parse(decodeDocument(await readFile(trustFile()))) as { documents?: unknown }
      restorePersistedDocuments(stored?.documents)
    } catch {
      /* none yet */
    }
    onPersistedDocumentsChange(schedulePersist)
    trustStoredLibrary(await loadState())
  })()
  return initialised
}

/** What the renderer may keep in library.json: known library folders only
    (it can drop one, never add one), Recent entries and the active note only
    when main vouches for them. */
function sanitizeForSave(next: unknown): unknown {
  if (typeof next !== 'object' || next === null) return next
  const record = next as Partial<InkwellState>
  return {
    ...record,
    folders: retainLibraryFolders(record.folders),
    recent: Array.isArray(record.recent) ? record.recent.filter((entry) => mayReadDocument(entry?.path)) : [],
    activePath: mayReadDocument(record.activePath) ? record.activePath : undefined
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_NAME_TEXT) : '')

/** A folder main itself chose or the user picked in a dialog (Add Folder, or
    the agent's notes-folder offer): checked, trusted in memory at once so its
    images and notes are allowed before the renderer's debounced library.json
    save lands, and read. The renderer then adds it to the library; it never
    names the folder. */
export async function trustAndReadLibraryFolder(folder: string): Promise<FolderResult> {
  const verdict = checkLibraryFolder(folder)
  if (!verdict.ok) return { ...EMPTY_FOLDER, refused: verdict.reason }
  trustLibraryFolder(verdict.folder)
  const documents = await walkMarkdownFiles(verdict.folder)
  trustDocuments(documents)
  return { folder: verdict.folder, documents }
}

/** Registers once; `getWindow` names the window dialogs attach to. */
export function registerDocumentIpc(getWindow: () => BrowserWindow | null): void {
  if (registered) return
  registered = true

  const showMessageBox = (options: Electron.MessageBoxOptions) => {
    const window = getWindow()
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options)
  }

  handle('document:confirm-discard', async (_event, names: unknown) => {
    const { response } = await showMessageBox({
      type: 'warning',
      title: 'Unsaved changes',
      message: 'Discard unsaved changes?',
      detail: `${text(names)} has unsaved changes that will be lost when you open something else.`,
      buttons: ['Cancel', 'Discard and open'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return response === 1
  })

  handle('document:open', async () => {
    try {
      const selection = await dialog.showOpenDialog({
        title: 'Open Markdown files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'markdown'] }]
      })
      if (selection.canceled) return []
      const files = (await Promise.all(selection.filePaths.filter(isMarkdown).map(readMarkdownFileSafely)))
        .filter((file): file is DocumentFile => file !== null)
      trustDocuments(files, path, { persist: true })
      return files
    } catch {
      return []
    }
  })

  handle('document:open-folder', async (): Promise<FolderResult> => {
    try {
      const selection = await dialog.showOpenDialog({
        title: 'Open a folder',
        properties: ['openDirectory']
      })
      if (selection.canceled || !selection.filePaths[0]) return EMPTY_FOLDER
      return await trustAndReadLibraryFolder(selection.filePaths[0])
    } catch {
      return EMPTY_FOLDER
    }
  })

  /* Re-reading a remembered folder on launch, and refreshing one the user has
     already added. Only a folder main knows the user chose. */
  handle('document:read-folder', async (_event, folder: unknown): Promise<FolderResult> => {
    if (!isKnownLibraryFolder(folder)) return EMPTY_FOLDER
    try {
      const details = await stat(folder)
      if (!details.isDirectory()) return EMPTY_FOLDER
      const documents = await walkMarkdownFiles(folder)
      trustDocuments(documents)
      return { folder, documents }
    } catch {
      /* Removed, renamed, or on an unmounted drive: the renderer drops it. */
      return EMPTY_FOLDER
    }
  })

  /* Reopening a recent file, which the renderer holds only as a path. Reading
     does not make a file writable; it was writable already or it is not. */
  handle('document:read', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    const files = await Promise.all(
      paths
        .filter((entry): entry is string => mayReadDocument(entry))
        .slice(0, 50)
        .map(readMarkdownFileSafely)
    )
    const read = files.filter((file): file is DocumentFile => file !== null)
    for (const file of read) trustNoteFolder(file.path)
    return read
  })

  /* A link in the reader to a local note (Mac AppModel.openLink): main
     resolves it against the folder of a note it vouched for, checks it,
     reads it, and from then on the target is readable. */
  handle('document:open-link', async (_event, request: unknown): Promise<LinkOpenResult> => {
    const record = typeof request === 'object' && request !== null ? request as Record<string, unknown> : {}
    if (!mayReadDocument(record.from)) return { ok: false, reason: '' }
    const target = resolveNoteLink(record.from, record.href, libraryFolders())
    if (!target.ok) return { ok: false, reason: '' }
    try {
      const details = await stat(target.path)
      if (!details.isFile()) throw new Error('not a file')
    } catch {
      return { ok: false, reason: `${path.basename(target.path)} is not there` }
    }
    const file = await readMarkdownFileSafely(target.path)
    if (!file) return { ok: false, reason: `Could not open ${path.basename(target.path)}` }
    if (mayWriteDocument(file.path)) trustDocument(file.path)
    else trustReadableDocument(file.path)
    return { ok: true, document: file }
  })

  handle('state:load', async () => {
    await initialiseDocumentTrust()
    const state = await loadState()
    return {
      ...state,
      folders: state.folders.filter((folder) => isKnownLibraryFolder(folder)),
      recent: state.recent.filter((entry) => mayReadDocument(entry.path)),
      activePath: mayReadDocument(state.activePath) ? state.activePath : undefined
    }
  })
  on('state:save', (_event, next: unknown) => { void saveState(sanitizeForSave(next)) })

  handle('file:rename', async (_event, payload: unknown) => {
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
    const name = typeof record.name === 'string' ? toFileName(record.name) : null
    const source = record.path
    /* Inkwell only ever renames Markdown documents it handed out. */
    if (!name || !mayWriteDocument(source)) {
      return { ok: false as const, reason: 'That is not a usable file name' }
    }
    const target = path.join(path.dirname(source), name)
    if (target === source) return { ok: true as const, path: source, name: path.basename(source) }
    /* A case-only rename ("a.md" → "A.md") "exists" on a case-insensitive volume
       because it is the same file; only refuse a genuinely different one. */
    const caseOnly = target.toLowerCase() === source.toLowerCase()
    if (!caseOnly && await exists(target)) return { ok: false as const, reason: `${name} already exists in that folder` }
    try {
      await rename(source, target)
      const details = await stat(target)
      forgetDocument(source)
      trustDocument(target, path, { persist: true })
      return { ok: true as const, path: target, name, savedAt: details.mtimeMs }
    } catch {
      return { ok: false as const, reason: 'Could not rename that file' }
    }
  })

  handle('file:duplicate', async (_event, filePath: unknown) => {
    if (!mayWriteDocument(filePath)) return null
    try {
      const target = await uniqueCopyPath(filePath)
      if (!target) return null
      await copyFile(filePath, target)
      const copy = await readMarkdownFileSafely(target)
      if (copy) trustDocument(copy.path, path, { persist: true })
      return copy
    } catch {
      return null
    }
  })

  /* Trash, never unlink: the desktop's trash is undoable and a Markdown note
     the user meant to keep is not worth a permanent delete. */
  handle('file:trash', async (_event, filePath: unknown) => {
    if (!mayWriteDocument(filePath)) return false
    try {
      await shell.trashItem(filePath)
      forgetDocument(filePath)
      return true
    } catch {
      return false
    }
  })

  handle('file:confirm-trash', async (_event, name: unknown) => {
    const { response } = await showMessageBox({
      type: 'warning',
      title: 'Move to trash',
      message: `Move ${text(name)} to the trash?`,
      detail: 'The file leaves the folder and goes to your desktop trash, where you can restore it.',
      buttons: ['Cancel', 'Move to trash'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return response === 1
  })

  /* Explorer would contact any server a path names: readable documents only. */
  on('file:reveal', (_event, filePath: unknown) => {
    if (mayRevealPath(filePath)) shell.showItemInFolder(filePath)
  })

  on('clipboard:write', (_event, value: unknown) => {
    if (typeof value === 'string' && value.length <= 1_000_000) clipboard.writeText(value)
  })

  handle('document:save', async (_event, payload: unknown): Promise<SaveResult> => {
    const record = typeof payload === 'object' && payload !== null ? payload as Partial<SavePayload> : {}
    if (typeof record.content !== 'string') return { canceled: true }
    const content = record.content
    const asked = record.path
    if (asked !== undefined && typeof asked !== 'string') return { canceled: true }

    let targetPath: string
    if (!asked || record.forceSaveAs === true || !mayWriteDocument(asked)) {
      /* A path main did not hand out is never written as asked. Not Markdown,
         or not even an absolute path: refused outright. A Markdown path:
         the user confirms it in a Save dialog seeded with it. */
      if (asked && !record.forceSaveAs && !mayWriteDocument(asked) && !(isPlainAbsolute(asked) && isMarkdown(asked))) {
        return { canceled: true, refused: 'Inkwell saves only Markdown notes' }
      }
      const seed = asked && isPlainAbsolute(asked) && isMarkdown(asked)
        ? asked
        : path.join(app.getPath('documents'), 'Untitled note.md')
      const window = getWindow()
      const options: Electron.SaveDialogOptions = {
        title: 'Save Markdown document',
        defaultPath: seed,
        filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'markdown'] }]
      }
      const selection = window && !window.isDestroyed()
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return { canceled: true }
      targetPath = isMarkdown(selection.filePath) ? selection.filePath : `${selection.filePath}.md`
    } else {
      targetPath = asked
      if (typeof record.knownMtime === 'number' && Number.isFinite(record.knownMtime)) {
        /* Another editor may have written this file since we read it.
           Overwriting silently would discard their work as surely as losing
           our own. */
        try {
          const current = await stat(targetPath)
          if (current.mtimeMs - record.knownMtime > 1) {
            const { response } = await showMessageBox({
              type: 'warning',
              title: 'File changed on disk',
              message: 'This file has changed since Inkwell opened it.',
              detail: `${path.basename(targetPath)} was modified by something else. Saving now replaces those changes.`,
              buttons: ['Cancel', 'Overwrite'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            })
            if (response !== 1) return { canceled: true }
          }
        } catch {
          /* Gone from disk: fall through and recreate it. */
        }
      }
    }

    /* Temp file + rename, with Windows retry/fallback (see writeAtomically). A
       failure comes back as a rejected invoke, which the renderer reports. */
    const savedAt = await writeAtomically(targetPath, content)
    trustDocument(targetPath, path, { persist: true })
    return { canceled: false, path: targetPath, savedAt }
  })
}
