import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ClipboardCopy, Copy, FolderOpen, PencilLine, Trash2, X } from 'lucide-react'
import { AgentPanel } from '../agent/AgentPanel'
import type { AppearanceProps } from '../components/AppearancePopover'
import { isAppTheme, isAppearanceMode } from '../../src-electron/ipc/contract'
import type { FolderResult } from '../../src-electron/ipc/contract'
import { EmptyState } from '../components/EmptyState'
import { Header } from '../components/Header'
import { Outline } from '../components/Outline'
import { RowMenu, type MenuItem } from '../components/RowMenu'
import { Sidebar } from '../components/Sidebar'
import { StatusBar } from '../components/StatusBar'
import { Editor, type EditorHandle } from '../editor/Editor'
import { FindController } from '../editor/FindController'
import { ephySave } from '../ephy/ephyClient'
import { EphyPicker } from '../ephy/EphyPicker'
import { installedReaderFonts } from '../fonts/installedFonts'
import { DEFAULT_READER_FONT, READER_FONTS, readerFontLabel } from '../fonts/readerFonts'
import { getHeadings } from '../lib/headings'
import {
  DRAFTS,
  EPHY,
  RECENT,
  adoptIntoFolders,
  buildGroups,
  isClosable,
  mergeRestoredFolders,
  mergeRestoredRecent,
  rememberRecentEntries,
  rowFor,
  sourceForPath as sourceIn,
  toDoc,
  type FolderSource,
  type LibraryGroup,
  type LibraryRow,
  type MarkdownDoc
} from '../lib/library'
import { DEFAULT_ZOOM, MAX_EPHY_LINKS, MAX_FOLDERS, MAX_RECENT, ZOOM_STEP, clampZoom } from '../lib/limits'
import { clampTitle, fileIdFor, fileNameFor, folderIdFor, folderLabel, isInside, isMarkdown, samePath } from '../lib/paths'
import { plural, wordCount as countWords } from '../lib/text'
import { classifyLink } from '../reader/links'
import { Reader } from '../reader/Reader'
import { ActiveDocumentContext, type ActiveDocumentValue } from './activeDocument'
import { runCommand, useCommand } from './commands'
import { IntegrationsContext, type DocumentPatch, type DocumentRekey, type IntegrationsValue } from './integrations'
import { acceleratorMap, isTextField, keyLikeOf, matchShortcut } from './shortcuts'
import { initialOutlineOpen, useResponsiveChrome } from './useResponsiveChrome'

/* App: all library state and the layout composition. Modules extend it
   through the command registry, the contexts (ActiveDocument, Integrations)
   and the components they own (see PARITY.md, "Module ownership"). */

const READER_FONT_VALUES = new Set<string>(READER_FONTS.map((font) => font.value))
const ACCELERATORS = acceleratorMap()

export function App() {
  const [documents, setDocuments] = useState<MarkdownDoc[]>([])
  const [folders, setFolders] = useState<FolderSource[]>([])
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  /* Nothing is persisted until the stored library has been read back, or the
     first render would save an empty library over a real one. */
  const [restored, setRestored] = useState(false)
  const [view, setView] = useState<ViewMode>('split')
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [outlineOpen, setOutlineOpen] = useState(initialOutlineOpen)
  const [agentOpen, setAgentOpen] = useState(false)
  /* Main owns these toggles; they are mirrored from its push events. */
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [ephyEnabled, setEphyEnabled] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [readerFont, setReaderFont] = useState<ReaderFont>(DEFAULT_READER_FONT)
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>('system')
  const [appTheme, setAppTheme] = useState<AppTheme>('inkwell')
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [ephyLinks, setEphyLinks] = useState<Record<string, EphyLink>>({})
  const [notice, setNotice] = useState('Reading your library')
  const [menu, setMenu] = useState<{ row: LibraryRow; x: number; y: number } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const editorRef = useRef<EditorHandle | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const draftSerial = useRef(0)
  /* Escape unmounts the rename input, which fires its blur handler on the way
     out. Without this the cancel would be committed as a rename. */
  const renameCanceled = useRef(false)
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const foldersRef = useRef(folders)
  foldersRef.current = folders

  const activeDocument = documents.find((doc) => doc.id === activeId)
  const headings = useMemo(() => getHeadings(activeDocument?.content ?? ''), [activeDocument?.content])
  const words = useMemo(() => countWords(activeDocument?.content ?? ''), [activeDocument?.content])

  const sourceForPath = useCallback((filePath: string) => sourceIn(folders, filePath), [folders])

  const rememberRecent = useCallback((files: { path: string; name: string }[]) => {
    if (!files.length) return
    const openedAt = Date.now()
    setRecent((current) => rememberRecentEntries(current, files, openedAt, MAX_RECENT))
  }, [])

  const forgetPath = useCallback((filePath: string) => {
    setDocuments((current) => current.filter((doc) => !samePath(doc.path, filePath)))
    setRecent((current) => current.filter((entry) => !samePath(entry.path, filePath)))
    setActiveId((current) => (current === fileIdFor(filePath) ? null : current))
  }, [])

  /* Restore the library: the folders that were open, the recent list, the
     document that was in front, and the view. A folder that has since been
     deleted or unmounted is dropped rather than reported — it is not an error
     that the user needs to answer for. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bridge = window.inkwell
      if (!bridge?.loadState) {
        setNotice('Nothing open')
        setRestored(true)
        return
      }

      let state: InkwellState
      try {
        state = await bridge.loadState()
      } catch {
        state = { folders: [], recent: [], readerFont: DEFAULT_READER_FONT, zoomLevel: DEFAULT_ZOOM, view: 'split', appearance: 'system', theme: 'inkwell', ephyLinks: {} }
      }

      const results = await Promise.all(state.folders.map(async (folder) => {
        try {
          return await bridge.readFolder(folder)
        } catch {
          return { folder: '', documents: [] as DocumentFile[] }
        }
      }))
      if (cancelled) return

      const liveFolders: FolderSource[] = []
      const restoredDocs: MarkdownDoc[] = []
      results.forEach((result) => {
        if (!result.folder) return
        const id = folderIdFor(result.folder)
        liveFolders.push({ id, name: folderLabel(result.folder), path: result.folder })
        result.documents.forEach((file) => {
          if (!restoredDocs.some((doc) => samePath(doc.path, file.path))) restoredDocs.push(toDoc(file, id))
        })
      })

      /* The document you were last in, when it is not inside one of the folders
         that just came back. */
      if (state.activePath && !restoredDocs.some((doc) => samePath(doc.path, state.activePath))) {
        const reopened = await bridge.readDocuments([state.activePath]).catch(() => [] as DocumentFile[])
        reopened.forEach((file) => restoredDocs.unshift(toDoc(file, RECENT)))
      }
      if (cancelled) return

      /* Merge, never replace: a folder added, a file opened or a draft started
         while the restore ran is kept, and wins over the restored copy. */
      const folderList = mergeRestoredFolders(liveFolders, foldersRef.current, MAX_FOLDERS)
      setFolders(folderList)
      setRecent((current) => mergeRestoredRecent(state.recent, current, MAX_RECENT))
      setReaderFont(state.readerFont)
      setAppearanceMode(state.appearance)
      setAppTheme(state.theme)
      setZoomLevel(state.zoomLevel)
      setView(state.view)
      setEphyLinks((current) => ({ ...state.ephyLinks, ...current }))
      const existing = documentsRef.current
      const kept = new Set(folderList.map((folder) => folder.id))
      const merged = adoptIntoFolders([
        ...existing,
        ...restoredDocs.filter((doc) => kept.has(doc.sourceId) || doc.sourceId === RECENT)
          .filter((doc) => !existing.some((item) => item.id === doc.id))
      ], folderList)
      setDocuments(merged)
      const active = merged.find((doc) => samePath(doc.path, state.activePath)) ?? merged[0]
      setActiveId((current) => current ?? active?.id ?? null)
      setNotice(merged.length ? `${plural(merged.length, 'document')} in your library` : 'Nothing open')
      setRestored(true)
    })()
    return () => { cancelled = true }
  }, [])

  /* Persist on a short delay: typing in the editor does not touch any of this,
     but adding and closing documents can arrive in bursts. Ephy notes have no
     path, so they never reach activePath or recent. */
  useEffect(() => {
    if (!restored) return
    const handle = window.setTimeout(() => {
      window.inkwell?.saveState?.({
        folders: folders.map((folder) => folder.path),
        recent: recent.slice(0, MAX_RECENT),
        activePath: activeDocument?.path,
        readerFont,
        zoomLevel,
        view,
        appearance: appearanceMode,
        theme: appTheme,
        ephyLinks
      })
    }, 400)
    return () => window.clearTimeout(handle)
  }, [restored, folders, recent, activeDocument?.path, readerFont, zoomLevel, view, appearanceMode, appTheme, ephyLinks])

  /* Main owns the palette: it forces the native theme, repaints the window
     background and answers on theme:changed. Not sent before the stored choice
     is read back, or the defaults would override what main loaded at startup. */
  useEffect(() => {
    if (restored) window.inkwell?.setAppearance?.({ appearance: appearanceMode, theme: appTheme })
  }, [restored, appearanceMode, appTheme])

  /* Typography stays a renderer concern; whole-display zoom uses Electron's
     native page zoom so chrome, editor and reader scale together. */
  useEffect(() => {
    document.documentElement.dataset.readerFont = readerFont
  }, [readerFont])

  useEffect(() => {
    window.inkwell?.setZoomLevel?.(zoomLevel)
  }, [zoomLevel])

  /* Follow Windows light/dark mode, or the active Omarchy palette on Linux.
     Tokens arrive as CSS custom properties and repaint without a reload. */
  useEffect(() => {
    const apply = (theme: { mode?: string; colors?: Record<string, string> } | null) => {
      if (!theme?.colors) return
      const root = document.documentElement
      for (const [key, value] of Object.entries(theme.colors)) {
        root.style.setProperty(key.startsWith('--') ? key : `--${key}`, value)
      }
      if (theme.mode) root.dataset.themeMode = theme.mode
    }
    void window.inkwell?.getTheme?.().then(apply).catch(() => undefined)
    return window.inkwell?.onThemeChange?.(apply)
  }, [])

  /* The enable toggles can flip from the menu, a context menu or a panel; main
     pushes every change, so the header, the panels and the menu agree. */
  useEffect(() => {
    const bridge = window.inkwell
    if (!bridge) return
    void bridge.agent?.getEnabled().then(setAgentEnabled).catch(() => undefined)
    void bridge.ephy?.getEnabled().then(setEphyEnabled).catch(() => undefined)
    const offAgent = bridge.agent?.onEnabledChange?.(setAgentEnabled)
    const offEphy = bridge.ephy?.onEnabledChange?.(setEphyEnabled)
    return () => {
      offAgent?.()
      offEphy?.()
    }
  }, [])

  /* Turning the agent off takes its panel away (Mac). */
  useEffect(() => {
    if (!agentEnabled) setAgentOpen(false)
  }, [agentEnabled])

  const chrome = useResponsiveChrome({ outlineOpen, setOutlineOpen, sidebarOpen, setSidebarOpen, agentOpen, focusMode })

  /* Opening files only ever adds: nothing already in the library is discarded,
     and a file that is already there is activated rather than duplicated. Ids
     are keyed on path so re-opening resolves to the same entry. */
  const addDocuments = useCallback((incoming: DocumentFile[]) => {
    if (!incoming.length) return
    setDocuments((current) => {
      const fresh = incoming
        .filter((file) => !current.some((doc) => samePath(doc.path, file.path)))
        .map((file) => toDoc(file, sourceForPath(file.path)))
      return fresh.length ? [...fresh, ...current] : current
    })
    setActiveId(fileIdFor(incoming[0].path))
    rememberRecent(incoming)
    setNotice(incoming.length === 1 ? `Opened ${incoming[0].name}` : `Opened ${incoming.length} files`)
  }, [rememberRecent, sourceForPath])

  /* Files from argv or a second instance can arrive before the restore has
     finished. They are queued and applied after it (Mac `pendingOpens`), so
     the restore can never wipe them. */
  const pendingOpens = useRef<DocumentFile[]>([])
  const restoredRef = useRef(false)
  restoredRef.current = restored

  useEffect(() => {
    return window.inkwell?.onOpenExternal?.((incoming) => {
      if (restoredRef.current) addDocuments(incoming)
      else pendingOpens.current.push(...incoming)
    })
  }, [addDocuments])

  useEffect(() => {
    if (!restored || !pendingOpens.current.length) return
    const queued = pendingOpens.current
    pendingOpens.current = []
    addDocuments(queued)
  }, [restored, addDocuments])

  const openFiles = useCallback(async () => {
    try {
      const incoming = await window.inkwell?.openDocuments()
      if (incoming?.length) addDocuments(incoming)
    } catch {
      setNotice('Could not open those files — check permissions and try again')
    }
  }, [addDocuments])

  /* Adding a folder is additive too. It is a *source*: a place the library
     watches, not a workspace that replaces what is already open. */
  const adoptFolder = useCallback((result: FolderResult): boolean => {
    if (result.refused) {
      setNotice(result.refused)
      return false
    }
    if (!result.folder) return false
    const folders = foldersRef.current
    const overlap = folders.find((folder) => isInside(result.folder, folder.path) || isInside(folder.path, result.folder))
    if (overlap) {
      setNotice(samePath(overlap.path, result.folder)
        ? `${overlap.name} is already in the library`
        : `That folder overlaps ${overlap.name}, which is already here`)
      return false
    }
    if (folders.length >= MAX_FOLDERS) {
      setNotice(`${MAX_FOLDERS} folders is the limit — remove one first`)
      return false
    }
    const id = folderIdFor(result.folder)
    const source: FolderSource = { id, name: folderLabel(result.folder), path: result.folder }
    foldersRef.current = [...folders, source]
    setFolders((current) => [...current, source])
    setDocuments((current) => {
      /* A file opened ad hoc that lives in this folder now belongs to it. */
      const adopted = current.map((doc) => (doc.path && isInside(doc.path, result.folder) ? { ...doc, sourceId: id } : doc))
      const fresh = result.documents
        .filter((file) => !adopted.some((doc) => samePath(doc.path, file.path)))
        .map((file) => toDoc(file, id))
      return [...adopted, ...fresh]
    })
    setActiveId((current) => current ?? (result.documents[0] ? fileIdFor(result.documents[0].path) : null))
    setNotice(`Added ${source.name} · ${plural(result.documents.length, 'file')}`)
    return true
  }, [])

  const addFolder = useCallback(async () => {
    try {
      const result = await window.inkwell?.openFolder()
      if (result) adoptFolder(result)
    } catch {
      setNotice('Could not read that folder — check permissions and try again')
    }
  }, [adoptFolder])

  /* Re-reads a folder from disk. Documents with unsaved edits are kept as they
     are: a refresh must never be a way to lose typing. */
  const refreshFolder = useCallback(async (source: FolderSource) => {
    const result = await window.inkwell?.readFolder(source.path).catch(() => null)
    if (!result?.folder) {
      setNotice(`${source.name} is no longer on disk`)
      return
    }
    setDocuments((current) => {
      const kept = current.filter((doc) => doc.sourceId !== source.id || doc.isDirty)
      const fresh = result.documents
        .filter((file) => !kept.some((doc) => samePath(doc.path, file.path)))
        .map((file) => toDoc(file, source.id))
      return [...kept, ...fresh]
    })
    setNotice(`Refreshed ${source.name} · ${plural(result.documents.length, 'file')}`)
  }, [])

  /* A file the agent wrote on disk inside a library folder: re-read that
     folder so a new note shows up (dirty notes are kept, as always). Main
     reports it under the renderer's own spelling of the folder. */
  useEffect(() => window.inkwell?.agent?.onFileWritten?.((written) => {
    const source = foldersRef.current.find((folder) => isInside(written.path, folder.path))
    if (source && isMarkdown(written.path)) void refreshFolder(source)
  }), [refreshFolder])

  const confirmDiscardOf = useCallback(async (dirty: MarkdownDoc[]) => {
    if (!dirty.length) return true
    const names = dirty.map((doc) => clampTitle(doc.name)).join(', ')
    const discard = await window.inkwell?.confirmDiscard?.(names)
    return discard !== false
  }, [])

  const removeFolder = useCallback(async (source: FolderSource) => {
    const owned = documents.filter((doc) => doc.sourceId === source.id)
    if (!(await confirmDiscardOf(owned.filter((doc) => doc.isDirty)))) return
    setFolders((current) => current.filter((folder) => folder.id !== source.id))
    setDocuments((current) => current.filter((doc) => doc.sourceId !== source.id))
    setActiveId((current) => (owned.some((doc) => doc.id === current) ? null : current))
    setNotice(`Removed ${source.name} from the library`)
  }, [confirmDiscardOf, documents])

  const updateContentOf = useCallback((id: string, content: string) => {
    if (!documentsRef.current.some((doc) => doc.id === id)) return false
    setDocuments((current) => current.map((doc) => doc.id === id
      ? { ...doc, content, isDirty: true, revision: (doc.revision ?? 0) + 1 }
      : doc))
    setNotice('Edited · not saved')
    return true
  }, [])

  /* One undoable edit through the editor when it shows this document, else a
     plain state update (Mac AppModel.replaceText). */
  const applyEditTo = useCallback((id: string, text: string) => {
    const editor = editorRef.current
    if (editor && editor.docId === id && editor.replaceAll(text)) return true
    return updateContentOf(id, text)
  }, [updateContentOf])

  const createDocument = useCallback(() => {
    draftSerial.current += 1
    const serial = draftSerial.current
    const newDocument: MarkdownDoc = {
      id: `draft:${serial}`,
      name: serial === 1 ? 'Untitled note.md' : `Untitled note ${serial}.md`,
      content: '# Untitled note\n\nStart with the smallest true sentence.\n',
      sourceId: DRAFTS,
      isDirty: true
    }
    setDocuments((current) => [newDocument, ...current])
    setActiveId(newDocument.id)
    setView('write')
    setNotice('New local draft · choose Save to place it')
    window.setTimeout(() => editorRef.current?.focus(), 40)
  }, [])

  const saveDocument = useCallback(async (forceSaveAs = false) => {
    if (!window.inkwell || !activeDocument) return
    const target = activeDocument

    /* Save on an Ephy note publishes to Ephy. Save As still writes a local file. */
    if (!forceSaveAs && target.sourceId === EPHY) {
      const revision = target.revision ?? 0
      const outcome = await ephySave(target)
      if (!outcome.ok) {
        setNotice(outcome.message)
        return
      }
      setDocuments((current) => current.map((doc) => doc.id === target.id ? {
        ...doc,
        isDirty: (doc.revision ?? 0) !== revision,
        ephy: doc.ephy ? { ...doc.ephy, version: outcome.version ?? doc.ephy.version } : doc.ephy
      } : doc))
      setNotice(`Saved ${clampTitle(target.name)} to Ephy`)
      return
    }

    const revision = target.revision ?? 0
    try {
      const saved = await window.inkwell.saveDocument({
        content: target.content,
        path: target.path,
        forceSaveAs,
        knownMtime: target.savedAt
      })
      if (saved.refused) setNotice(saved.refused)
      if (saved.canceled || !saved.path) return
      const savedPath = saved.path
      const fileName = fileNameFor(savedPath) || target.name
      /* A draft that has just been given a path stops being a draft: it moves
         to the folder that now holds it, or to recent. */
      const sourceId = sourceForPath(savedPath)
      const newId = fileIdFor(savedPath)
      /* Typing that continued while the write ran keeps the document dirty
         (Mac revision counter). Save As onto a file open elsewhere in the
         library: that entry now describes stale content, so this replaces it. */
      const stillDirty = (documentsRef.current.find((doc) => doc.id === target.id)?.revision ?? 0) !== revision
      setDocuments((current) => current
        .filter((doc) => newId === target.id || doc.id !== newId)
        .map((doc) => doc.id === target.id ? {
          ...doc,
          id: newId,
          path: savedPath,
          name: fileName,
          sourceId,
          savedAt: saved.savedAt,
          isDirty: (doc.revision ?? 0) !== revision
        } : doc))
      setActiveId((current) => (current === target.id ? newId : current))
      if (sourceId === RECENT) rememberRecent([{ path: savedPath, name: fileName }])
      setNotice(stillDirty ? `Saved ${fileName} · newer edits not saved` : `Saved ${fileName}`)
    } catch {
      setNotice('Could not save this document — try Save As again')
    }
  }, [activeDocument, rememberRecent, sourceForPath])

  /* Closing takes a document out of the library. For a folder file that would
     be meaningless — the folder still holds it — so only drafts, Ephy notes and
     recent files offer it. */
  const closeRow = useCallback(async (row: LibraryRow) => {
    const doc = row.doc
    if (doc?.isDirty && !(await confirmDiscardOf([doc]))) return
    if (doc) {
      const index = documents.findIndex((item) => item.id === doc.id)
      const remaining = documents.filter((item) => item.id !== doc.id)
      setDocuments(remaining)
      /* Land on the neighbour rather than nothing, and on nothing when that was
         the last document — an empty library is a legitimate state. */
      if (activeId === doc.id) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null)
    }
    if (row.kind === 'recent' && row.path) setRecent((current) => current.filter((entry) => !samePath(entry.path, row.path)))
    setNotice(row.kind === 'recent'
      ? `Removed ${clampTitle(row.name)} from recent`
      : `Closed ${clampTitle(row.name)}`)
  }, [activeId, confirmDiscardOf, documents])

  /* Opening a row that has never been loaded — a recent file from a previous
     session. Everything else is already in memory and just becomes active. */
  const openRow = useCallback(async (row: LibraryRow) => {
    if (row.doc) {
      setActiveId(row.doc.id)
      return
    }
    if (!row.path) return
    const files = await window.inkwell?.readDocuments([row.path]).catch(() => [] as DocumentFile[])
    if (!files?.length) {
      setNotice(`${clampTitle(row.name)} is no longer at that path`)
      forgetPath(row.path)
      return
    }
    addDocuments(files)
  }, [addDocuments, forgetPath])

  /* Open Recent, the jump list, and local Markdown links in the reader: any
     absolute Markdown path. Activates it if it is open, else reads it in. */
  const openPath = useCallback((filePath: string) => {
    const open = documentsRef.current.find((doc) => samePath(doc.path, filePath))
    if (open) {
      setActiveId(open.id)
      return
    }
    const entry = recent.find((item) => samePath(item.path, filePath))
    void openRow({ key: `recent:${filePath}`, name: entry?.name ?? fileNameFor(filePath), path: filePath, kind: 'recent', meta: 'Not open' })
  }, [openRow, recent])

  const openPathCommand = (arg?: string) => {
    if (arg && isMarkdown(arg)) openPath(arg)
  }

  /* A link clicked in the reader (Mac AppModel.openLink, src/reader/links.ts).
     A note link goes to main, which resolves it against this note's folder
     and validates it; the result opens like any openPath (activated when it
     is already open). */
  const followLink = useCallback(async (href: string, fromPath: string | undefined) => {
    const action = classifyLink(href)
    if (action.kind === 'anchor') {
      const reader = document.querySelector('.reader-panel')
      const target = action.ids.map((id) => reader?.querySelector(`#${CSS.escape(id)}`)).find(Boolean)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (action.kind === 'external') {
      /* Main's window-open handler hands http(s) and mailto to the desktop. */
      window.open(action.url, '_blank', 'noopener,noreferrer')
      return
    }
    if (action.kind !== 'note' || !fromPath || !window.inkwell?.openLink) return
    const result = await window.inkwell.openLink({ from: fromPath, href: action.href }).catch(() => null)
    if (!result) return
    if (!result.ok) {
      if (result.reason) setNotice(result.reason)
      return
    }
    const open = documentsRef.current.find((doc) => samePath(doc.path, result.document.path))
    if (open) setActiveId(open.id)
    else addDocuments([result.document])
  }, [addDocuments])

  const startRename = useCallback((row: LibraryRow) => {
    renameCanceled.current = false
    setRenamingKey(row.key)
    setRenameDraft(row.name)
  }, [])

  const commitRename = useCallback(async (row: LibraryRow) => {
    const nextName = renameDraft.trim()
    setRenamingKey(null)
    if (renameCanceled.current) {
      renameCanceled.current = false
      return
    }
    if (!row.path || !nextName || nextName === row.name) return
    const result = await window.inkwell?.renameDocument({ path: row.path, name: nextName })
    if (!result) return
    if (!result.ok) {
      setNotice(result.reason)
      return
    }
    const previousPath = row.path
    setDocuments((current) => current.map((doc) => samePath(doc.path, previousPath) ? {
      ...doc,
      id: fileIdFor(result.path),
      path: result.path,
      name: result.name,
      savedAt: result.savedAt ?? doc.savedAt
    } : doc))
    setRecent((current) => current.map((entry) => samePath(entry.path, previousPath)
      ? { ...entry, path: result.path, name: result.name }
      : entry))
    setEphyLinks((current) => {
      const link = Object.entries(current).find(([linked]) => samePath(linked, previousPath))
      if (!link) return current
      const next = { ...current }
      delete next[link[0]]
      next[result.path] = link[1]
      return next
    })
    setActiveId((current) => (current === fileIdFor(previousPath) ? fileIdFor(result.path) : current))
    setNotice(`Renamed to ${clampTitle(result.name)}`)
  }, [renameDraft])

  const duplicateRow = useCallback(async (row: LibraryRow) => {
    if (!row.path) return
    const file = await window.inkwell?.duplicateDocument(row.path).catch(() => null)
    if (!file) {
      setNotice(`Could not duplicate ${clampTitle(row.name)}`)
      return
    }
    setDocuments((current) => [toDoc(file, sourceForPath(file.path)), ...current])
    setActiveId(fileIdFor(file.path))
    setNotice(`Duplicated as ${clampTitle(file.name)}`)
  }, [sourceForPath])

  const trashRow = useCallback(async (row: LibraryRow) => {
    if (!row.path) return
    const confirmed = await window.inkwell?.confirmTrash(row.name)
    if (confirmed !== true) return
    const trashed = await window.inkwell?.trashDocument(row.path).catch(() => false)
    if (!trashed) {
      setNotice(`Could not move ${clampTitle(row.name)} to the trash`)
      return
    }
    forgetPath(row.path)
    setNotice(`Moved ${clampTitle(row.name)} to the trash`)
  }, [forgetPath])

  const revealRow = useCallback((row: LibraryRow) => {
    if (row.path) window.inkwell?.revealDocument(row.path)
  }, [])

  const copyPathOf = useCallback((row: LibraryRow) => {
    if (!row.path) return
    window.inkwell?.copyText(row.path)
    setNotice('Path copied')
  }, [])

  const menuItemsFor = useCallback((row: LibraryRow): MenuItem[] => {
    const items: MenuItem[] = [
      { key: 'open', label: row.doc ? 'Open' : 'Open file', icon: <BookOpen size={14} />, run: () => void openRow(row) }
    ]
    if (row.path) {
      items.push(
        { key: 'rename', label: 'Rename…', icon: <PencilLine size={14} />, run: () => startRename(row) },
        { key: 'duplicate', label: 'Duplicate', icon: <Copy size={14} />, run: () => void duplicateRow(row) },
        { key: 'reveal', label: 'Reveal in file manager', icon: <FolderOpen size={14} />, run: () => revealRow(row) },
        { key: 'copy', label: 'Copy path', icon: <ClipboardCopy size={14} />, run: () => copyPathOf(row) }
      )
    }
    if (row.kind !== 'folder') {
      items.push({
        key: 'close',
        separated: true,
        label: row.kind === 'recent' ? 'Remove from recent' : row.kind === 'ephy' ? 'Close' : 'Discard draft',
        icon: <X size={14} />,
        run: () => void closeRow(row)
      })
    }
    if (row.path) {
      items.push({
        key: 'trash',
        label: 'Move to trash…',
        icon: <Trash2 size={14} />,
        danger: true,
        separated: row.kind === 'folder',
        run: () => void trashRow(row)
      })
    }
    return items
  }, [closeRow, copyPathOf, duplicateRow, openRow, revealRow, startRename, trashRow])

  const groups = useMemo(() => buildGroups({ documents, folders, recent, query }), [documents, folders, query, recent])

  /* The active document as a row, derived directly rather than found in the
     (search-filtered) groups, so a search that hides it cannot disable Close
     or the file commands. Folder files stay excluded from Close for the reason
     the row menu excludes them. */
  const activeRow = useMemo(() => (activeDocument ? rowFor(activeDocument) : null), [activeDocument])
  const closableRow = isClosable(activeRow) ? activeRow : null
  const activeFileRow = activeRow?.path ? activeRow : null

  /* A search expands everything: a collapsed group hiding the only match reads
     as "no results". */
  const isOpenGroup = (group: LibraryGroup) => Boolean(query.trim()) || !collapsed.includes(group.id)
  const toggleGroup = (id: string) =>
    setCollapsed((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])

  /* Focus is orthogonal to the view mode rather than a fourth mode: focus +
     read, focus + split, and focus + write are all legitimate combinations.
     It just hides the surrounding chrome, whatever the current view is. */
  const toggleFocus = useCallback(() => {
    setFocusMode((current) => !current)
  }, [])

  const changeZoom = useCallback((amount: number) => {
    setZoomLevel((current) => clampZoom(current + amount))
  }, [])

  const resetAppearance = useCallback(() => {
    setReaderFont(DEFAULT_READER_FONT)
    setAppearanceMode('system')
    setAppTheme('inkwell')
    setZoomLevel(DEFAULT_ZOOM)
  }, [])

  const switchToHeading = (id: string) => {
    if (view === 'write') setView('read')
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  }

  /* Rename from the keyboard or menu needs the row on screen. */
  const renameActive = () => {
    if (!activeFileRow) return
    setFocusMode(false)
    setSidebarOpen(true)
    setQuery('')
    startRename(activeFileRow)
  }

  /* Find in Documents: the library's search field, brought on screen. */
  const focusLibrarySearch = () => {
    setFocusMode(false)
    setSidebarOpen(true)
    window.setTimeout(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }, 40)
  }

  /* Dismiss transient appearance chrome before changing the surrounding
     workspace. Focus mode comes next because it encloses the outline. */
  const escape = () => {
    if (appearanceOpen) setAppearanceOpen(false)
    else if (focusMode) toggleFocus()
    else setOutlineOpen(false)
  }

  /* ---- Commands owned by App. The find family belongs to FindController,
     Ephy to EphyPicker, checkForUpdates to UpdateNotice. ---- */
  useCommand('newNote', createDocument)
  useCommand('open', () => openFiles())
  useCommand('openRecent', openPathCommand)
  useCommand('openPath', openPathCommand)
  useCommand('clearRecent', () => setRecent([]))
  useCommand('addFolder', () => addFolder())
  useCommand('save', () => saveDocument())
  useCommand('saveAs', () => saveDocument(true))
  useCommand('closeDocument', () => { if (closableRow) void closeRow(closableRow) })
  useCommand('rename', renameActive)
  useCommand('duplicate', () => { if (activeFileRow) void duplicateRow(activeFileRow) })
  useCommand('reveal', () => { if (activeFileRow) revealRow(activeFileRow) })
  useCommand('copyPath', () => { if (activeFileRow) copyPathOf(activeFileRow) })
  useCommand('trash', () => { if (activeFileRow) void trashRow(activeFileRow) })
  useCommand('findInDocuments', focusLibrarySearch)
  useCommand('viewRead', () => setView('read'))
  useCommand('viewSplit', () => setView('split'))
  useCommand('viewWrite', () => setView('write'))
  useCommand('toggleLibrary', () => setSidebarOpen((open) => !open))
  useCommand('toggleOutline', () => setOutlineOpen((open) => !open))
  useCommand('focus', toggleFocus)
  useCommand('zoomIn', () => changeZoom(ZOOM_STEP))
  useCommand('zoomOut', () => changeZoom(-ZOOM_STEP))
  useCommand('zoomReset', () => setZoomLevel(DEFAULT_ZOOM))
  useCommand('setReaderFont', (arg) => { if (arg && READER_FONT_VALUES.has(arg)) setReaderFont(arg as ReaderFont) })
  useCommand('setAppearance', (arg) => { if (isAppearanceMode(arg)) setAppearanceMode(arg) })
  useCommand('setTheme', (arg) => { if (isAppTheme(arg)) setAppTheme(arg) })
  useCommand('toggleFullScreen', () => window.inkwell?.fullScreen?.toggle())
  useCommand('escape', escape)
  useCommand('toggleAgentPanel', () => { if (agentEnabled) setAgentOpen((open) => !open) })

  /* The one keyboard dispatcher. Attached once; the registry always runs the
     latest handlers. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = matchShortcut(keyLikeOf(event), isTextField(event.target))
      if (!shortcut) return
      if (shortcut.claim !== false) event.preventDefault()
      runCommand(shortcut.id, shortcut.arg)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* Menu clicks and jump-list entries arrive from main as commands. */
  useEffect(() => window.inkwell?.menu?.onCommand((command) => { runCommand(command.id, command.arg) }), [])

  const anyDirty = documents.some((doc) => doc.isDirty)
  useEffect(() => {
    window.inkwell?.setDirty(anyDirty)
  }, [anyDirty])

  /* The window title tracks the document in front: `• notes.md — Inkwell`
     while it has unsaved changes. */
  const windowTitle = activeDocument
    ? `${activeDocument.isDirty ? '• ' : ''}${activeDocument.name} — Inkwell`
    : 'Inkwell'
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])

  /* View ▸ Reading Font, with Mac's labels and "(not installed)" marks.
     Re-detected whenever Appearance opens, like the picker. */
  const menuReaderFonts = useMemo<MenuState['readerFonts']>(() => {
    const installed = installedReaderFonts()
    return READER_FONTS.map((font) => ({
      value: font.value,
      label: readerFontLabel(font, installed.has(font.value)),
      ...(font.startsBuiltInGroup ? { separated: true } : {})
    }))
  }, [appearanceOpen])

  /* What the application menu needs, pushed whenever it changes. */
  const menuState = useMemo<MenuState>(() => ({
    recent: recent.map((entry) => ({ path: entry.path, name: entry.name })),
    hasDocument: Boolean(activeDocument),
    hasFile: Boolean(activeDocument?.path),
    canClose: Boolean(closableRow),
    isDirty: Boolean(activeDocument?.isDirty),
    isEphy: activeDocument?.sourceId === EPHY,
    view,
    focusMode,
    sidebarOpen,
    outlineOpen,
    agentOpen,
    zoomLevel,
    appearance: appearanceMode,
    theme: appTheme,
    readerFont,
    readerFonts: menuReaderFonts,
    accelerators: ACCELERATORS
  }), [recent, activeDocument, closableRow, view, focusMode, sidebarOpen, outlineOpen, agentOpen, zoomLevel, appearanceMode, appTheme, readerFont, menuReaderFonts])
  const menuStateKey = JSON.stringify(menuState)
  useEffect(() => {
    window.inkwell?.menu?.setState(JSON.parse(menuStateKey) as MenuState)
  }, [menuStateKey])

  /* The agent's sandbox is the library's folders. Every open note's path goes
     too, so main can route the agent's reads and writes of ANY open note to
     its buffer, whatever spelling (junction, mapped drive) the agent uses. */
  const agentRoots = folders.map((folder) => folder.path).join('\n')
  const openPaths = documents.flatMap((doc) => (doc.path ? [doc.path] : [])).join('\n')
  const activePath = activeDocument?.path
  const activeDraft = Boolean(activeDocument && !activeDocument.path && activeDocument.sourceId === DRAFTS)
  useEffect(() => {
    window.inkwell?.agent?.setContext({
      roots: agentRoots ? agentRoots.split('\n') : [],
      activePath,
      openPaths: openPaths ? openPaths.split('\n') : [],
      activeDraft
    })
  }, [agentRoots, activePath, openPaths, activeDraft])

  /* Main added a folder for the agent (its notes-folder offer): adopt it like
     File ▸ Add Folder, then answer once it is in `folders`. The answer is sent
     from the effect below, which runs AFTER the setContext effect above in the
     same commit, so main sees the new agent roots before it hears the reply. */
  const adoptRequest = useRef<{ requestId: string; folder: string } | null>(null)
  useEffect(() => window.inkwell?.library?.onAdoptFolder((request) => {
    if (adoptFolder(request.result)) adoptRequest.current = { requestId: request.requestId, folder: request.result.folder }
    else window.inkwell?.library?.respondAdoptFolder({ requestId: request.requestId, ok: false })
  }), [adoptFolder])
  useEffect(() => {
    const pending = adoptRequest.current
    if (!pending || !folders.some((folder) => samePath(folder.path, pending.folder))) return
    adoptRequest.current = null
    window.inkwell?.library?.respondAdoptFolder({ requestId: pending.requestId, ok: true })
  }, [folders])

  const activeDocumentValue = useMemo<ActiveDocumentValue>(() => ({
    doc: activeDocument
      ? {
          id: activeDocument.id,
          name: activeDocument.name,
          content: activeDocument.content,
          path: activeDocument.path,
          sourceId: activeDocument.sourceId,
          isDirty: Boolean(activeDocument.isDirty)
        }
      : null,
    applyEdit: (text) => (activeDocument ? applyEditTo(activeDocument.id, text) : false)
  }), [activeDocument, applyEditTo])

  const integrationsValue = useMemo<IntegrationsValue>(() => ({
    documents,
    folders,
    ephyLinks,
    setEphyLink: (linkPath, link) => setEphyLinks((current) => {
      const existing = Object.keys(current).find((key) => samePath(key, linkPath))
      const next = { ...current }
      if (existing) delete next[existing]
      if (link) {
        if (Object.keys(next).length >= MAX_EPHY_LINKS) return current
        next[linkPath] = link
      }
      return next
    }),
    addInMemoryDocument: (doc) => {
      setDocuments((current) => current.some((item) => item.id === doc.id) ? current : [doc, ...current])
      setActiveId(doc.id)
    },
    updateDocument: (id: string, patch: DocumentPatch) =>
      setDocuments((current) => current.map((doc) => doc.id === id ? { ...doc, ...patch } : doc)),
    rekeyDocument: (oldId: string, next: DocumentRekey) => {
      if (!documentsRef.current.some((doc) => doc.id === oldId)) return false
      setDocuments((current) => current
        .filter((doc) => next.id === oldId || doc.id !== next.id)
        .map((doc) => doc.id === oldId ? { ...doc, ...next } : doc))
      setActiveId((current) => (current === oldId ? next.id : current))
      return true
    },
    resetUndo: (id: string) => {
      const editor = editorRef.current
      if (editor && editor.docId === id) editor.resetHistory()
    },
    applyEditTo,
    notify: setNotice,
    agentOpen,
    setAgentOpen,
    agentEnabled,
    ephyEnabled
  }), [documents, folders, ephyLinks, applyEditTo, agentOpen, agentEnabled, ephyEnabled])

  const appearance: AppearanceProps = {
    open: appearanceOpen,
    setOpen: setAppearanceOpen,
    appearance: appearanceMode,
    setAppearance: setAppearanceMode,
    theme: appTheme,
    setTheme: setAppTheme,
    readerFont,
    setReaderFont,
    zoomLevel,
    changeZoom,
    reset: resetAppearance
  }

  const shellClass = [
    'app-shell',
    sidebarOpen ? 'sidebar-open' : 'sidebar-collapsed',
    outlineOpen ? '' : 'outline-collapsed',
    agentOpen ? 'agent-open' : 'agent-collapsed',
    focusMode ? 'focus-mode' : '',
    focusMode && view === 'split' ? 'split-focus' : ''
  ].filter(Boolean).join(' ')

  return (
    <ActiveDocumentContext.Provider value={activeDocumentValue}>
      <IntegrationsContext.Provider value={integrationsValue}>
        <main className={shellClass}>
          <Sidebar
            groups={groups}
            activeId={activeId}
            restored={restored}
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            isOpenGroup={isOpenGroup}
            onToggleGroup={toggleGroup}
            activeRow={activeRow}
            closableRow={closableRow}
            onNewNote={createDocument}
            onOpen={() => void openFiles()}
            onAddFolder={() => void addFolder()}
            onCloseRow={(row) => void closeRow(row)}
            onOpenRow={(row) => void openRow(row)}
            onRefreshFolder={(source) => void refreshFolder(source)}
            onRemoveFolder={(source) => void removeFolder(source)}
            onRowMenu={(row, x, y) => setMenu({ row, x, y })}
            renamingKey={renamingKey}
            renameDraft={renameDraft}
            onRenameDraft={setRenameDraft}
            onRenameCommit={(row) => void commitRename(row)}
            onRenameCancel={() => {
              renameCanceled.current = true
              setRenamingKey(null)
            }}
          />

          <section className="workspace">
            <Header
              title={activeDocument ? clampTitle(activeDocument.name) : 'Inkwell'}
              notice={notice}
              hasDocument={Boolean(activeDocument)}
              view={view}
              focusMode={focusMode}
              sidebarOpen={sidebarOpen}
              outlineOpen={outlineOpen}
              agentEnabled={agentEnabled}
              agentOpen={agentOpen}
              isEphyNote={activeDocument?.sourceId === EPHY}
              chrome={chrome}
              appearance={appearance}
              onToggleSidebar={() => setSidebarOpen((open) => !open)}
              onToggleFocus={toggleFocus}
              onToggleOutline={() => setOutlineOpen((open) => !open)}
              onToggleAgent={() => setAgentOpen((open) => !open)}
              onSetView={setView}
              onSave={() => void saveDocument()}
              onSaveAs={() => void saveDocument(true)}
            />

            {activeDocument ? (
              <div className={`document-canvas view-${view}`}>
                {view !== 'write' && (
                  <div className="reader-panel">
                    <Reader
                      content={activeDocument.content}
                      notePath={activeDocument.path}
                      onLink={(href) => void followLink(href, activeDocument.path)}
                      retryKey={agentRoots}
                    />
                  </div>
                )}
                {view !== 'read' && (
                  <Editor
                    ref={editorRef}
                    docId={activeDocument.id}
                    content={activeDocument.content}
                    onChange={(content) => { updateContentOf(activeDocument.id, content) }}
                  />
                )}
              </div>
            ) : (
              <EmptyState onNewNote={createDocument} onOpen={() => void openFiles()} onAddFolder={() => void addFolder()} />
            )}

            <StatusBar words={activeDocument ? words : 0} sections={headings.length} />
          </section>

          <Outline headings={headings} onSelect={switchToHeading} onClose={() => setOutlineOpen(false)} />

          <aside className="agent-panel" aria-label="Agent">
            <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} />
          </aside>

          {menu && (
            <RowMenu
              items={menuItemsFor(menu.row)}
              origin={{ x: menu.x, y: menu.y }}
              onClose={() => setMenu(null)}
            />
          )}
        </main>
        <FindController editor={editorRef} view={view} />
        <EphyPicker />
      </IntegrationsContext.Provider>
    </ActiveDocumentContext.Provider>
  )
}

export default App
