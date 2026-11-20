/* The renderer <-> main contract. ONE file, imported as types by both sides:
   - src-electron/* import it normally,
   - src/vite-env.d.ts re-exports the shapes as globals for the renderer,
   - src-electron/preload.ts imports it with `import type` only. The renderer is
     sandboxed, so the preload may never import a local module at runtime; type
     imports are erased by tsc and cost nothing.

   Every channel name is in CHANNELS below, and src-electron/contract.integrity
   .test.ts fails if the preload and CHANNELS drift apart in either direction.
   See PARITY.md, "Module ownership & contracts". */

/* ------------------------------------------------------------------------ */
/* Documents and library state                                               */
/* ------------------------------------------------------------------------ */

export type DocumentFile = {
  name: string
  path: string
  content: string
  /** mtime at read time, used to detect an external edit before overwriting. */
  savedAt: number
}

export type RecentEntry = { path: string; name: string; openedAt: number }

/** Every reading font, as stored in library.json. Mac's raw values, so one
    library.json reads the same on both platforms. The five installed-only
    fonts (bookerly … geist-mono) are used when the machine has them; the
    choice is kept when it does not. Labels live in src/fonts/readerFonts.ts. */
export const READER_FONT_VALUES = [
  'editorial',
  'bookerly',
  'ember',
  'roboto',
  'ubuntu',
  'geist-mono',
  'classic',
  'sans',
  'system',
  'mono'
] as const

export type ReaderFont = typeof READER_FONT_VALUES[number]

export const isReaderFont = (value: unknown): value is ReaderFont =>
  typeof value === 'string' && (READER_FONT_VALUES as readonly string[]).includes(value)

/** Light or dark for the app itself, as stored in library.json (Mac
    `AppearanceMode`). Case order is menu order. */
export const APPEARANCE_VALUES = ['system', 'light', 'dark'] as const
export type AppearanceMode = typeof APPEARANCE_VALUES[number]
export const APPEARANCE_LABELS: Record<AppearanceMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }
export const isAppearanceMode = (value: unknown): value is AppearanceMode =>
  typeof value === 'string' && (APPEARANCE_VALUES as readonly string[]).includes(value)

/** The app's color theme (Mac `AppTheme`). The palettes live in
    src-electron/theme.ts; this is only the names, for storage and menus. */
export const APP_THEME_VALUES = ['inkwell', 'paper', 'slate', 'forest', 'midnight'] as const
export type AppTheme = typeof APP_THEME_VALUES[number]
export const APP_THEME_LABELS: Record<AppTheme, string> = {
  inkwell: 'Inkwell', paper: 'Paper', slate: 'Slate', forest: 'Forest', midnight: 'Midnight'
}
export const isAppTheme = (value: unknown): value is AppTheme =>
  typeof value === 'string' && (APP_THEME_VALUES as readonly string[]).includes(value)

/** `theme:set-appearance` payload: what the renderer tells main. */
export type AppearanceChoice = { appearance: AppearanceMode; theme: AppTheme }

export type ViewMode = 'read' | 'split' | 'write'

/** A local file linked to an Ephy artifact. Ids, titles and versions only —
    never note content. Kept in library.json, capped at MAX_EPHY_LINKS. */
export type EphyLink = { id: string; title: string; version?: number }

/** The remembered library: folder sources, recent files, and where you were. */
export type InkwellState = {
  folders: string[]
  recent: RecentEntry[]
  activePath?: string
  readerFont: ReaderFont
  zoomLevel: number
  view: ViewMode
  appearance: AppearanceMode
  theme: AppTheme
  /** Keyed by absolute local path. */
  ephyLinks: Record<string, EphyLink>
}

export type RenameResult =
  | { ok: true; path: string; name: string; savedAt?: number }
  | { ok: false; reason: string }

/** `path` must be a document main handed out (see trustedDocuments.ts);
    any other Markdown path goes through a Save dialog seeded with it, and a
    non-Markdown path is refused outright. */
export type SavePayload = { content: string; path?: string; forceSaveAs?: boolean; knownMtime?: number }
/** `refused` says why main would not write where it was asked (nothing was written). */
export type SaveResult = { canceled: boolean; path?: string; savedAt?: number; refused?: string }

/** Add Folder: `refused` explains a folder main will not take (a drive root,
    the home folder or one holding it); `folder` is then empty. */
export type FolderResult = { folder: string; documents: DocumentFile[]; refused?: string }

/** A link clicked in the reader: the note it is in and the raw href. Main
    resolves and validates it (src-electron/readerLinks.ts). */
export type LinkOpenRequest = { from: string; href: string }
/** `reason` is shown as a notice when set; an empty reason means "do nothing". */
export type LinkOpenResult = { ok: true; document: DocumentFile } | { ok: false; reason: string }

export type ThemePayload = {
  name: string
  mode: 'light' | 'dark'
  colors: Record<string, string>
}

/* ------------------------------------------------------------------------ */
/* Commands and the application menu                                         */
/* ------------------------------------------------------------------------ */

/** Every command in the app. The renderer's registry (src/app/commands.ts)
    dispatches these; the application menu sends them over `menu:command`. */
export type CommandId =
  // File
  | 'newNote'
  | 'open'
  | 'openRecent'          // arg: absolute path (Open Recent menu, jump list)
  | 'openPath'            // arg: absolute Markdown path (reader links, argv-like opens)
  | 'clearRecent'
  | 'addFolder'
  | 'save'
  | 'saveAs'
  | 'closeDocument'
  | 'rename'
  | 'duplicate'
  | 'reveal'
  | 'copyPath'
  | 'trash'
  // Edit / find
  | 'find'
  | 'replace'
  | 'findNext'
  | 'findPrevious'
  | 'useSelectionForFind'
  | 'findInDocuments'
  // View
  | 'viewRead'
  | 'viewSplit'
  | 'viewWrite'
  | 'toggleLibrary'
  | 'toggleOutline'
  | 'focus'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'setReaderFont'       // arg: ReaderFont
  | 'setAppearance'       // arg: AppearanceMode
  | 'setTheme'            // arg: AppTheme
  | 'toggleFullScreen'
  | 'escape'
  // Integrations
  | 'toggleAgentPanel'
  | 'ephyOpen'
  | 'ephySave'
  | 'ephySaveAsNew'
  | 'ephyOpenInBrowser'
  | 'ephyGetLatest'
  // App
  | 'checkForUpdates'

export type MenuCommand = { id: CommandId; arg?: string }

/** What the renderer pushes on `menu:state` whenever any of it changes, so the
    main-process menu can enable, check and relabel its items, fill Open Recent
    and the jump list, and show the renderer's accelerators. */
export type MenuState = {
  recent: { path: string; name: string }[]
  hasDocument: boolean
  /** The active document has a path on disk (rename/duplicate/reveal/…). */
  hasFile: boolean
  /** Close Document is possible (drafts, recent and Ephy rows only). */
  canClose: boolean
  isDirty: boolean
  /** The active document is an Ephy note. */
  isEphy: boolean
  view: ViewMode
  focusMode: boolean
  sidebarOpen: boolean
  outlineOpen: boolean
  agentOpen: boolean
  zoomLevel: number
  appearance: AppearanceMode
  theme: AppTheme
  readerFont: ReaderFont
  /** View ▸ Reading Font, in picker order. `label` already says "(not
      installed)" when the renderer found the font missing; `separated` draws
      a separator before the entry (Mac `startsBuiltInGroup`). */
  readerFonts: { value: ReaderFont; label: string; separated?: boolean }[]
  /** Electron accelerator strings from the renderer's shortcut table, so the
      menu displays exactly the keys the renderer dispatches. Menu items must
      use `registerAccelerator: false` — the renderer is the one dispatcher. */
  accelerators: Partial<Record<CommandId, string>>
}

/* ------------------------------------------------------------------------ */
/* Updates                                                                   */
/* ------------------------------------------------------------------------ */

/** A newer GitHub Release of mrelph/InkwellWindows exists. `url` is its
    release page, built by main from the validated tag. Null everywhere else —
    see src-electron/update.ts. */
export type UpdateNotice = { version: string; url: string }

/** What the person chose in the manual check's native message box (Mac's
    update alert): install now, later, or skip this version (main has already
    dismissed it). */
export type UpdateChoice = 'install' | 'later' | 'skip'

export type UpdateCheckResult =
  | { kind: 'available'; notice: UpdateNotice; choice?: UpdateChoice }
  | { kind: 'upToDate'; version: string }
  | { kind: 'failed'; message: string }

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; notice: UpdateNotice }
  | { state: 'downloading'; version: string; /** 0..1, or null when unknown */ progress: number | null }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export type UpdateInstallResult = { ok: true } | { ok: false; message: string }

/* ------------------------------------------------------------------------ */
/* Agent (ACP) — modelled on InkwellMac Sources/InkwellCore/ACP/*            */
/* ------------------------------------------------------------------------ */

export type AgentHarnessId = 'kiro' | 'codex' | 'claude'

export type AgentHarnessInfo = {
  id: AgentHarnessId
  title: string
  installed: boolean
  /** Resolved executable, when installed. */
  path?: string
  /** Main opens this itself on request; the page never supplies a URL. */
  helpUrl: string
  /** The persisted choice (settings `agentHarness`): the one a new session starts. */
  selected: boolean
}

export type AgentSessionState =
  | { state: 'disabled' }
  | { state: 'stopped' }
  | { state: 'starting'; harness: AgentHarnessId }
  | { state: 'ready'; harness: AgentHarnessId; agentTitle?: string }
  | { state: 'prompting'; harness: AgentHarnessId; agentTitle?: string }
  | { state: 'failed'; message: string }

export type AgentToolCall = {
  toolCallId: string
  title: string
  kind: string
  /** pending | in_progress | completed | failed | cancelled */
  status: string
  detail: string
  paths: string[]
  /** 'Inkwell' (its sandbox) or 'you' (a Deny); absent when the harness itself failed. */
  refusedBy?: 'Inkwell' | 'you'
  refusal?: string
}

export type AgentPlanItem = { content: string; status: string; priority: string }

export type AgentTranscriptKind = 'user' | 'agentMarkdown' | 'thought' | 'plan' | 'toolCall' | 'status' | 'error'

export type AgentTranscriptEntry = {
  /** Stable per session; an event with an existing id replaces that entry. */
  id: number
  kind: AgentTranscriptKind
  text: string
  messageId?: string
  tool?: AgentToolCall
  plan?: AgentPlanItem[]
}

export type AgentEvent =
  | { type: 'reset' }
  | { type: 'entry'; entry: AgentTranscriptEntry }
  | { type: 'state'; state: AgentSessionState }

export type AgentNoteContext = {
  name: string
  path?: string
  content: string
  /** A draft with no file yet. */
  unsaved: boolean
  /** The renderer's document id, so main can name an unsaved draft exactly
      in later buffer requests. */
  docId?: string
}

export type AgentPromptPayload = { text: string; includeNote: boolean; note?: AgentNoteContext }

export type AgentPermissionOption = {
  optionId: string
  name: string
  /** allow_once | allow_always | reject_once | reject_always */
  kind: string
}

export type DiffLine = { op: 'keep' | 'remove' | 'add' | 'fold'; text: string }

export type AgentPermissionRequest = {
  requestId: string
  /** 'tool': ACP session/request_permission. 'write': Inkwell's own allow-once
      sheet before an fs/write_text_file lands. */
  kind: 'tool' | 'write'
  title: string
  detail: string
  options: AgentPermissionOption[]
  /** For writes: the resolved path and a folded line diff. */
  path?: string
  diff?: DiffLine[]
}

/** Answer to a permission request: the chosen optionId, or null for cancelled
    (the safest choice — never an allow). */
export type AgentPermissionResponse = { requestId: string; optionId: string | null }

/** Main asks the renderer about open notes, because unsaved buffers live in
    the renderer. 'read' returns the buffer if that path is open; 'write'
    applies text to the open note as one undoable edit (no disk write). */
export type AgentBufferRequest =
  | { requestId: string; op: 'read'; path: string; docId?: string; draft?: boolean }
  | { requestId: string; op: 'write'; path: string; content: string; docId?: string; draft?: boolean }

/** A file the agent created or replaced ON DISK (an open note's write goes to
    its buffer and never produces this). The renderer refreshes the library
    folder holding it so a new note appears. */
export type AgentFileWritten = { path: string; created: boolean }

export type AgentBufferResponse =
  | { requestId: string; open: false }
  | { requestId: string; open: true; content: string }
  | { requestId: string; open: true; applied: boolean }

/** The sandbox roots (library folders), the active note and every open
    note's path, pushed by the renderer. Main keeps only paths it vouched for,
    and maps each real path back to the renderer's spelling, so a note opened
    through a junction, a mapped drive or a short name still routes to its
    buffer (Mac `document(atResolvedPath:)`). */
export type AgentContext = {
  roots: string[]
  activePath?: string
  openPaths?: string[]
  /** The active note is an unsaved draft: with no folder shared the agent can still edit it. */
  activeDraft?: boolean
}

/** `library:adopt-folder` (main → renderer): main chose and already trusts
    this folder (the agent's notes-folder offer) and asks the renderer to add
    it to the library exactly as File ▸ Add Folder does. The renderer answers
    on `library:adopt-folder-result` once the folder is in its state and the
    agent context has been pushed. The reply grants nothing: main already
    decided, and `state:save` still can only keep folders main knows. */
export type LibraryAdoptRequest = { requestId: string; result: FolderResult }
export type LibraryAdoptResponse = { requestId: string; ok: boolean }

export type AgentResult = { ok: true } | { ok: false; message: string }

/* ------------------------------------------------------------------------ */
/* Ephy — modelled on InkwellMac Sources/InkwellCore/Ephy.swift               */
/* ------------------------------------------------------------------------ */

export type EphyErrorCode =
  | 'disabled'
  | 'notFound'
  | 'signedOut'
  | 'timedOut'
  | 'conflict'
  | 'unavailable'
  | 'unsupported'
  | 'invalidId'
  | 'badOutput'
  | 'failed'
  | 'notImplemented'

export type EphyResult<T> = { ok: true; value: T } | { ok: false; error: EphyErrorCode; message: string }

export type EphyStatus = {
  enabled: boolean
  cliFound: boolean
  cliPath?: string
  /** null while unknown (not checked yet, or disabled). */
  sessionValid: boolean | null
  message?: string
}

export type EphyArtifact = { id: string; title: string; format: string; updatedAt?: number }

export type EphyDocument = { id: string; title: string; format: string; version?: number; content: string }

export type EphyListPage = { artifacts: EphyArtifact[]; nextCursor?: string }

export type EphyLatest = { upToDate: true; version?: number } | { upToDate: false; document: EphyDocument }

export const EPHY_PAGE_SIZE = 100
export const MAX_EPHY_LINKS = 500

/* ------------------------------------------------------------------------ */
/* Assets                                                                    */
/* ------------------------------------------------------------------------ */

/** Custom scheme for note-relative local images, registered privileged before
    app ready (src-electron/assets.ts). The URL layout is the reader/assets
    workstream's to define; the scheme name is fixed here. */
export const ASSET_SCHEME = 'inkwell-asset'

/* ------------------------------------------------------------------------ */
/* The bridge                                                                */
/* ------------------------------------------------------------------------ */

export type Unsubscribe = () => void

export type InkwellBridge = {
  platform: NodeJS.Platform
  openDocuments: () => Promise<DocumentFile[]>
  openFolder: () => Promise<FolderResult>
  /** Re-reads a library folder main already knows (chosen in Add Folder, or in
      library.json at startup) — no dialog. Any other folder reads as gone. */
  readFolder: (folder: string) => Promise<FolderResult>
  /** Reads recent files back in, which the library holds only as paths. Only
      paths main vouched for, or inside a library folder, are read. */
  readDocuments: (paths: string[]) => Promise<DocumentFile[]>
  /** A reader link to a local Markdown note (relative or `file:`). */
  openLink: (request: LinkOpenRequest) => Promise<LinkOpenResult>
  loadState: () => Promise<InkwellState>
  saveState: (state: InkwellState) => void
  /** Zooms the complete Electron renderer, including chrome and document. */
  setZoomLevel: (percent: number) => void
  renameDocument: (payload: { path: string; name: string }) => Promise<RenameResult>
  duplicateDocument: (filePath: string) => Promise<DocumentFile | null>
  /** Moves the file to the desktop trash. Never an unlink. */
  trashDocument: (filePath: string) => Promise<boolean>
  confirmTrash: (name: string) => Promise<boolean>
  revealDocument: (filePath: string) => void
  copyText: (text: string) => void
  /** The last known update, from cache. Null when there is nothing to say. */
  getUpdate: () => Promise<UpdateNotice | null>
  /** Silences this version; anything newer speaks up again. */
  dismissUpdate: (version: string) => void
  /** Opens the tag page for the known update in the desktop browser. */
  openUpdate: () => void
  onUpdateAvailable: (listener: (notice: UpdateNotice) => void) => Unsubscribe
  saveDocument: (payload: SavePayload) => Promise<SaveResult>
  setDirty: (isDirty: boolean) => void
  /** Resolves the active Omarchy theme, or the host system palette. */
  getTheme: () => Promise<ThemePayload>
  onThemeChange: (listener: (theme: ThemePayload) => void) => Unsubscribe
  /** Tells main the chosen mode and theme (it validates, forces the native
      theme, repaints the window and answers on `theme:changed`). */
  setAppearance: (choice: AppearanceChoice) => void
  /** Native confirm before discarding unsaved work. True means discard. */
  confirmDiscard: (names: string) => Promise<boolean>
  /** Files passed on argv or opened while the app was already running. */
  onOpenExternal: (listener: (documents: DocumentFile[]) => void) => Unsubscribe

  menu: {
    /** `menu:state` — renderer → main, on every change. */
    setState: (state: MenuState) => void
    /** `menu:command` — main → renderer, from a menu click or jump list. */
    onCommand: (listener: (command: MenuCommand) => void) => Unsubscribe
  }

  fullScreen: {
    toggle: () => void
    get: () => Promise<boolean>
    onChange: (listener: (isFullScreen: boolean) => void) => Unsubscribe
  }

  update: {
    /** Check for Updates…: asks now and always answers. */
    check: () => Promise<UpdateCheckResult>
    /** Download, verify and install the known update, then relaunch. */
    install: () => Promise<UpdateInstallResult>
    onStatus: (listener: (status: UpdateStatus) => void) => Unsubscribe
    getAutoCheck: () => Promise<boolean>
    setAutoCheck: (on: boolean) => Promise<boolean>
    /** `update:auto-check-changed`: the setting changed from any source. */
    onAutoCheckChange: (listener: (on: boolean) => void) => Unsubscribe
  }

  spellcheck: {
    get: () => Promise<boolean>
    set: (on: boolean) => Promise<boolean>
    /** `spellcheck:changed`: toggled from the menu, the context menu or set(). */
    onChange: (listener: (on: boolean) => void) => Unsubscribe
  }

  /* The agent and Ephy enable toggles are main-only (Integrations menu): a
     compromised page must not be able to turn on a command-running agent or
     publish as the user. The renderer reads them and hears every change. */
  agent: {
    getEnabled: () => Promise<boolean>
    /** `agent:enabled-changed`: toggled from the Integrations menu. */
    onEnabledChange: (listener: (on: boolean) => void) => Unsubscribe
    /** The persisted "Include current note" (settings `agentIncludeNote`). */
    getIncludeNote: () => Promise<boolean>
    setIncludeNote: (on: boolean) => Promise<boolean>
    listHarnesses: () => Promise<AgentHarnessInfo[]>
    /** Opens the harness's install page; main owns the URL. */
    openHarnessHelp: (harness: AgentHarnessId) => void
    getState: () => Promise<AgentSessionState>
    start: (harness: AgentHarnessId) => Promise<AgentResult>
    newSession: () => Promise<AgentResult>
    prompt: (payload: AgentPromptPayload) => Promise<AgentResult>
    cancel: () => void
    stop: () => void
    setContext: (context: AgentContext) => void
    onEvent: (listener: (event: AgentEvent) => void) => Unsubscribe
    onPermissionRequest: (listener: (request: AgentPermissionRequest) => void) => Unsubscribe
    respondPermission: (response: AgentPermissionResponse) => void
    onBufferRequest: (listener: (request: AgentBufferRequest) => void) => Unsubscribe
    respondBuffer: (response: AgentBufferResponse) => void
    /** `agent:file-written`: the agent wrote a file on disk. */
    onFileWritten: (listener: (written: AgentFileWritten) => void) => Unsubscribe
    /** Integrations ▸ Agent ▸ Add Notes Folder… from the panel: main shows the
        dialog and adds the folder. False when declined, not applicable (agent
        off, a folder already shared) or it could not be added. */
    addNotesFolder: () => Promise<boolean>
  }

  library: {
    /** `library:adopt-folder`: main asks the renderer to add a folder it chose. */
    onAdoptFolder: (listener: (request: LibraryAdoptRequest) => void) => Unsubscribe
    respondAdoptFolder: (response: LibraryAdoptResponse) => void
  }

  ephy: {
    getEnabled: () => Promise<boolean>
    /** `ephy:enabled-changed`: toggled from the Integrations menu. */
    onEnabledChange: (listener: (on: boolean) => void) => Unsubscribe
    status: () => Promise<EphyStatus>
    list: (request: { cursor?: string; limit?: number }) => Promise<EphyResult<EphyListPage>>
    open: (id: string) => Promise<EphyResult<EphyDocument>>
    /** Refused with error 'conflict' when someone published past baseVersion. */
    save: (request: { id: string; content: string; baseVersion?: number }) => Promise<EphyResult<{ version?: number }>>
    saveAsNew: (request: { title: string; content: string }) => Promise<EphyResult<{ id: string; version?: number }>>
    /** Main resolves the viewer URL via the CLI and opens it; https only. */
    openInBrowser: (id: string) => Promise<EphyResult<null>>
    getLatest: (request: { id: string; version?: number }) => Promise<EphyResult<EphyLatest>>
  }
}

/** Every IPC channel name, for reference and for the ownership table. */
export const CHANNELS = {
  // documents (ipc/documents.ts)
  documentOpen: 'document:open',
  documentOpenFolder: 'document:open-folder',
  documentReadFolder: 'document:read-folder',
  documentRead: 'document:read',
  documentOpenLink: 'document:open-link',
  documentSave: 'document:save',
  documentConfirmDiscard: 'document:confirm-discard',
  documentOpenedExternally: 'document:opened-externally',
  documentSetDirty: 'document:set-dirty',
  fileRename: 'file:rename',
  fileDuplicate: 'file:duplicate',
  fileTrash: 'file:trash',
  fileConfirmTrash: 'file:confirm-trash',
  fileReveal: 'file:reveal',
  clipboardWrite: 'clipboard:write',
  stateLoad: 'state:load',
  stateSave: 'state:save',
  // theme (main.ts)
  themeGet: 'theme:get',
  themeChanged: 'theme:changed',
  themeSetAppearance: 'theme:set-appearance',
  // window (main.ts)
  fullScreenToggle: 'window:toggle-fullscreen',
  fullScreenGet: 'window:get-fullscreen',
  fullScreenChanged: 'window:fullscreen-changed',
  // menu (menu.ts)
  menuState: 'menu:state',
  menuCommand: 'menu:command',
  // updates (ipc/update.ts)
  updateGet: 'update:get',
  updateDismiss: 'update:dismiss',
  updateOpen: 'update:open',
  updateAvailable: 'update:available',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status',
  updateGetAutoCheck: 'update:get-auto-check',
  updateSetAutoCheck: 'update:set-auto-check',
  updateAutoCheckChanged: 'update:auto-check-changed',
  // spellcheck (contextMenu.ts)
  spellcheckGet: 'spellcheck:get',
  spellcheckSet: 'spellcheck:set',
  spellcheckChanged: 'spellcheck:changed',
  // agent (acp/index.ts)
  agentGetEnabled: 'agent:get-enabled',
  agentEnabledChanged: 'agent:enabled-changed',
  agentGetIncludeNote: 'agent:get-include-note',
  agentSetIncludeNote: 'agent:set-include-note',
  agentListHarnesses: 'agent:list-harnesses',
  agentOpenHarnessHelp: 'agent:open-harness-help',
  agentGetState: 'agent:get-state',
  agentStart: 'agent:start',
  agentNewSession: 'agent:new-session',
  agentPrompt: 'agent:prompt',
  agentCancel: 'agent:cancel',
  agentStop: 'agent:stop',
  agentSetContext: 'agent:set-context',
  agentEvent: 'agent:event',
  agentPermissionRequest: 'agent:permission-request',
  agentPermissionResponse: 'agent:permission-response',
  agentBufferRequest: 'agent:buffer-request',
  agentBufferResponse: 'agent:buffer-response',
  agentFileWritten: 'agent:file-written',
  agentAddNotesFolder: 'agent:add-notes-folder',
  // library adoption (ipc/documents.ts)
  libraryAdoptFolder: 'library:adopt-folder',
  libraryAdoptFolderResult: 'library:adopt-folder-result',
  // ephy (ephy/index.ts)
  ephyGetEnabled: 'ephy:get-enabled',
  ephyEnabledChanged: 'ephy:enabled-changed',
  ephyStatus: 'ephy:status',
  ephyList: 'ephy:list',
  ephyOpen: 'ephy:open',
  ephySave: 'ephy:save',
  ephySaveAsNew: 'ephy:save-as-new',
  ephyOpenInBrowser: 'ephy:open-in-browser',
  ephyGetLatest: 'ephy:get-latest'
} as const
