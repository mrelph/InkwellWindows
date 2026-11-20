import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { on } from './ipcGuard'
import { mayReadDocument } from './trustedDocuments'
import { isReaderFont, type CommandId, type MenuCommand, type MenuState, type ReaderFont } from './ipc/contract'
import { onSettingChange } from './settings'
import { isSpellcheckEnabled, setSpellcheckEnabled } from './contextMenu'
import { getAutoCheck, setAutoCheck } from './update'
import { isAgentEnabled, setAgentEnabled } from './acp/index'
import { isEphyEnabled, setEphyEnabled } from './ephy/index'

/* The application menu (File / Edit / View / Integrations / Help), Open Recent
   + Clear, the taskbar jump list (app.addRecentDocument), and the Alt-revealed
   menu bar (the window sets autoHideMenuBar). Owned by the menu workstream (A).

   - The renderer pushes MenuState on `menu:state`; the menu is rebuilt from it,
     debounced so typing (which flips isDirty and little else) never churns it.
   - A click sends `menu:command` ({ id, arg? }); the renderer routes it through
     runCommand. Spellcheck, the agent/Ephy enable toggles and the auto-check
     toggle act in main directly (their state lives here). Any change to those
     settings, from any source, rebuilds the menu (onSettingChange).
   - View ▸ Reading Font is built from MenuState.readerFonts, which the
     renderer fills from src/fonts/readerFonts.ts (labels, order, "(not
     installed)"); until the first push it shows the built-in default only.
   - The jump list carries a "New note" task (`--new-note`, handled in main.ts).
   - Accelerators come from MenuState.accelerators and are display-only
     (`registerAccelerator: false`): the renderer's shortcut table is the one
     keyboard dispatcher, so a registered accelerator would fire twice. */

let registered = false
let current: BrowserWindow | null = null
let state: MenuState | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let jumpList = new Set<string>()
const listeners = new Set<(state: MenuState) => void>()
/* Resolved by the window's first `menu:state`. App subscribes to
   `menu:command` (and to external opens) in effects that run before the one
   that pushes MenuState, so after this a command sent to it is never lost. */
let rendererReady: { promise: Promise<void>; resolve: () => void } | null = null
const READY_TIMEOUT_MS = 15_000

const REBUILD_DELAY_MS = 120
const MAX_ZOOM = 140
const MIN_ZOOM = 80

/* Before the renderer's first push: just the default, so the submenu is never empty. */
const FALLBACK_READER_FONTS: MenuState['readerFonts'] = [{ value: 'editorial', label: 'Default (Source Serif 4)' }]
const MAX_READER_FONTS = 32

const EMPTY_STATE: MenuState = {
  recent: [],
  hasDocument: false,
  hasFile: false,
  canClose: false,
  isDirty: false,
  isEphy: false,
  view: 'read',
  focusMode: false,
  sidebarOpen: true,
  outlineOpen: false,
  agentOpen: false,
  zoomLevel: 100,
  readerFont: 'editorial',
  readerFonts: FALLBACK_READER_FONTS,
  accelerators: {}
}

/** The latest MenuState the renderer pushed, or null before the first push. */
export function getMenuState(): MenuState | null {
  return state
}

/** Subscribe to MenuState changes; returns an unsubscribe function. */
export function onMenuState(listener: (state: MenuState) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Resolves once the current window's renderer can receive commands (its
    first MenuState push), or after a timeout. */
export function whenRendererReady(): Promise<void> {
  if (!rendererReady) return Promise.resolve()
  return Promise.race([rendererReady.promise, new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS))])
}

/** Sends a command to the renderer's registry. */
export function sendMenuCommand(id: CommandId, arg?: string): void {
  const window = current
  if (!window || window.isDestroyed()) return
  const command: MenuCommand = arg === undefined ? { id } : { id, arg }
  window.webContents.send('menu:command', command)
}

function showAbout(): void {
  const options = {
    type: 'info' as const,
    title: 'About Inkwell',
    message: 'Inkwell',
    detail: `Version ${app.getVersion()}\nA local-first Markdown reader and editor.`,
    buttons: ['OK'],
    noLink: true
  }
  const window = current
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options)
  else void dialog.showMessageBox(options)
}

function sanitizeState(raw: Record<string, unknown>): MenuState {
  const bool = (key: keyof MenuState) => raw[key] === true
  /* Open Recent and the jump list carry only paths main vouches for: a jump
     list entry is resolved by the shell, which would contact any server a
     UNC path names. */
  const recent = Array.isArray(raw.recent)
    ? raw.recent.filter((entry): entry is { path: string; name: string } =>
        typeof entry === 'object' && entry !== null &&
        mayReadDocument((entry as { path?: unknown }).path) &&
        typeof (entry as { name?: unknown }).name === 'string')
        .slice(0, 20)
        .map((entry) => ({ path: entry.path, name: entry.name.slice(0, 300) }))
    : []
  const accelerators: MenuState['accelerators'] = {}
  if (typeof raw.accelerators === 'object' && raw.accelerators !== null) {
    for (const [id, accelerator] of Object.entries(raw.accelerators)) {
      if (typeof accelerator === 'string' && accelerator) accelerators[id as CommandId] = accelerator
    }
  }
  const view = raw.view === 'split' || raw.view === 'write' ? raw.view : 'read'
  const font: ReaderFont = isReaderFont(raw.readerFont) ? raw.readerFont : 'editorial'
  const readerFonts: MenuState['readerFonts'] = []
  if (Array.isArray(raw.readerFonts)) {
    for (const entry of raw.readerFonts.slice(0, MAX_READER_FONTS)) {
      if (typeof entry !== 'object' || entry === null) continue
      const { value, label, separated } = entry as { value?: unknown; label?: unknown; separated?: unknown }
      if (!isReaderFont(value) || typeof label !== 'string' || !label.trim()) continue
      if (readerFonts.some((choice) => choice.value === value)) continue
      readerFonts.push({ value, label: label.slice(0, 80), ...(separated === true ? { separated: true } : {}) })
    }
  }
  return {
    recent,
    hasDocument: bool('hasDocument'),
    hasFile: bool('hasFile'),
    canClose: bool('canClose'),
    isDirty: bool('isDirty'),
    isEphy: bool('isEphy'),
    view,
    focusMode: bool('focusMode'),
    sidebarOpen: bool('sidebarOpen'),
    outlineOpen: bool('outlineOpen'),
    agentOpen: bool('agentOpen'),
    zoomLevel: typeof raw.zoomLevel === 'number' ? raw.zoomLevel : 100,
    readerFont: font,
    readerFonts: readerFonts.length ? readerFonts : FALLBACK_READER_FONTS,
    accelerators
  }
}

function buildTemplate(s: MenuState): MenuItemConstructorOptions[] {
  const accel = (id: CommandId) => s.accelerators[id]
  /** A command item: display-only accelerator, click goes to the renderer. */
  const command = (
    label: string,
    id: CommandId,
    extra: Partial<MenuItemConstructorOptions> = {},
    arg?: string
  ): MenuItemConstructorOptions => ({
    label,
    accelerator: accel(id),
    registerAccelerator: false,
    click: () => sendMenuCommand(id, arg),
    ...extra
  })

  const ephyEnabled = isEphyEnabled()
  const agentEnabled = isAgentEnabled()

  const recent: MenuItemConstructorOptions[] = s.recent.length
    ? s.recent.map((entry) => ({
        label: entry.name,
        click: () => sendMenuCommand('openRecent', entry.path)
      }))
    : [{ label: 'No Recent Files', enabled: false }]

  const file: MenuItemConstructorOptions[] = [
    command('&New Note', 'newNote'),
    command('&Open…', 'open'),
    command('Add &Folder…', 'addFolder'),
    {
      label: 'Open &Recent',
      submenu: [
        ...recent,
        { type: 'separator' },
        {
          label: 'Clear Recent',
          enabled: s.recent.length > 0,
          click: () => {
            app.clearRecentDocuments()
            jumpList = new Set()
            sendMenuCommand('clearRecent')
          }
        }
      ]
    },
    { type: 'separator' },
    command('&Save', 'save', { enabled: s.hasDocument }),
    command('Save &As…', 'saveAs', { enabled: s.hasDocument }),
    command('&Close Document', 'closeDocument', { enabled: s.canClose }),
    { type: 'separator' },
    command('Re&name', 'rename', { enabled: s.hasFile }),
    command('&Duplicate', 'duplicate', { enabled: s.hasFile }),
    command('Show in &Explorer', 'reveal', { enabled: s.hasFile }),
    command('Copy &Path', 'copyPath', { enabled: s.hasFile }),
    command('Move to Recycle &Bin', 'trash', { enabled: s.hasFile })
  ]
  if (ephyEnabled) {
    file.push(
      { type: 'separator' },
      {
        label: 'E&phy',
        submenu: [
          command('Open from Ephy…', 'ephyOpen'),
          command('Save to Ephy', 'ephySave', { enabled: s.hasDocument }),
          command('Save as New Ephy Artifact…', 'ephySaveAsNew', { enabled: s.hasDocument }),
          { type: 'separator' },
          command('Open in Browser', 'ephyOpenInBrowser', { enabled: s.isEphy }),
          command('Get Latest', 'ephyGetLatest', { enabled: s.isEphy })
        ]
      }
    )
  }
  file.push({ type: 'separator' }, { label: 'E&xit', role: 'quit' })

  const edit: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
    { type: 'separator' },
    {
      label: '&Find',
      submenu: [
        command('Find…', 'find', { enabled: s.hasDocument }),
        command('Replace…', 'replace', { enabled: s.hasDocument && s.view !== 'read' }),
        command('Find Next', 'findNext', { enabled: s.hasDocument }),
        command('Find Previous', 'findPrevious', { enabled: s.hasDocument }),
        command('Use Selection for Find', 'useSelectionForFind', { enabled: s.hasDocument }),
        { type: 'separator' },
        command('Find in Documents…', 'findInDocuments')
      ]
    },
    {
      label: 'Spe&lling',
      submenu: [
        {
          label: 'Check Spelling While Typing',
          type: 'checkbox',
          checked: isSpellcheckEnabled(),
          click: (item) => {
            setSpellcheckEnabled(item.checked)
            scheduleRebuild(true)
          }
        }
      ]
    }
  ]

  const view: MenuItemConstructorOptions[] = [
    command('&Read', 'viewRead', { type: 'radio', checked: s.view === 'read' }),
    command('S&plit', 'viewSplit', { type: 'radio', checked: s.view === 'split' }),
    command('&Write', 'viewWrite', { type: 'radio', checked: s.view === 'write' }),
    { type: 'separator' },
    command(s.sidebarOpen ? 'Hide &Library' : 'Show &Library', 'toggleLibrary'),
    command(s.outlineOpen ? 'Hide &Outline' : 'Show &Outline', 'toggleOutline'),
    command('Focus Writing', 'focus', { type: 'checkbox', checked: s.focusMode }),
    { type: 'separator' },
    command('Zoom &In', 'zoomIn', { enabled: s.zoomLevel < MAX_ZOOM }),
    command('Zoom &Out', 'zoomOut', { enabled: s.zoomLevel > MIN_ZOOM }),
    command('&Actual Size', 'zoomReset', { enabled: s.zoomLevel !== 100 }),
    { type: 'separator' },
    {
      label: 'Reading &Font',
      submenu: s.readerFonts.flatMap((choice): MenuItemConstructorOptions[] => [
        ...(choice.separated ? [{ type: 'separator' as const }] : []),
        {
          label: choice.label,
          type: 'radio',
          checked: s.readerFont === choice.value,
          click: () => sendMenuCommand('setReaderFont', choice.value)
        }
      ])
    },
    { type: 'separator' },
    command('&Full Screen', 'toggleFullScreen', { accelerator: accel('toggleFullScreen') ?? 'F11' })
  ]

  const integrations: MenuItemConstructorOptions[] = [
    {
      label: 'Enable &Ephy',
      type: 'checkbox',
      checked: ephyEnabled,
      click: (item) => {
        setEphyEnabled(item.checked)
        scheduleRebuild(true)
      }
    },
    {
      label: 'Enable &Agent',
      type: 'checkbox',
      checked: agentEnabled,
      click: (item) => {
        setAgentEnabled(item.checked)
        scheduleRebuild(true)
      }
    },
    { type: 'separator' },
    command(s.agentOpen ? 'Hide Agent &Panel' : 'Show Agent &Panel', 'toggleAgentPanel', { enabled: agentEnabled })
  ]

  const help: MenuItemConstructorOptions[] = [
    command('Check for &Updates…', 'checkForUpdates'),
    {
      label: 'Check &Automatically',
      type: 'checkbox',
      checked: getAutoCheck(),
      click: (item) => {
        setAutoCheck(item.checked)
        scheduleRebuild(true)
      }
    },
    { type: 'separator' },
    { label: '&About Inkwell', click: showAbout }
  ]

  return [
    { label: '&File', submenu: file },
    { label: '&Edit', submenu: edit },
    { label: '&View', submenu: view },
    { label: '&Integrations', submenu: integrations },
    { label: '&Help', submenu: help }
  ]
}

/** Keeps the taskbar jump list's Recent category in step with Open Recent. */
function syncJumpList(s: MenuState): void {
  const next = new Set(s.recent.map((entry) => entry.path))
  const unchanged = next.size === jumpList.size && [...next].every((entry) => jumpList.has(entry))
  if (unchanged) return
  // addRecentDocument only appends, so a removed entry means clear and re-add
  // (oldest first, so the newest ends up on top).
  if ([...jumpList].some((entry) => !next.has(entry))) app.clearRecentDocuments()
  for (const entry of [...s.recent].reverse()) app.addRecentDocument(entry.path)
  jumpList = next
}

function rebuild(): void {
  rebuildTimer = null
  const s = state ?? EMPTY_STATE
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(s)))
  if (state) syncJumpList(state)
}

/** Debounced so a burst of state pushes (typing flips isDirty) builds one menu. */
function scheduleRebuild(immediate = false): void {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, immediate ? 0 : REBUILD_DELAY_MS)
}

function sameState(a: MenuState | null, b: MenuState): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}

/** The taskbar jump list's Tasks: "New note" relaunches Inkwell with
    `--new-note`, which the single-instance handler in main.ts turns into the
    `newNote` command in the running window. In development the executable is
    electron.exe, which also needs the app path. */
function registerJumpListTasks(): void {
  if (process.platform !== 'win32') return
  const args = app.isPackaged ? '--new-note' : `"${app.getAppPath()}" --new-note`
  try {
    app.setUserTasks([{
      program: process.execPath,
      arguments: args,
      iconPath: process.execPath,
      iconIndex: 0,
      title: 'New note',
      description: 'Start a new note in Inkwell'
    }])
  } catch (error) {
    console.warn('Could not set the jump list tasks', error)
  }
}

/** Registers once; later calls rebind the window commands are sent to. */
export function registerMenu(window: BrowserWindow): void {
  current = window
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  rendererReady = { promise, resolve }
  // Hidden until Alt is pressed; Alt toggles it.
  window.setAutoHideMenuBar(true)
  if (registered) return
  registered = true
  rebuild()
  registerJumpListTasks()
  /* The enable toggles, spellcheck and auto-check live in settings; whoever
     flips one (this menu, the context menu, a panel), the checkmarks follow. */
  onSettingChange((key) => {
    if (key === 'agentEnabled' || key === 'ephyEnabled' || key === 'spellcheck' || key === 'autoUpdateCheck') scheduleRebuild(true)
  })
  on('menu:state', (event, next: unknown) => {
    if (current && !current.isDestroyed() && event.sender === current.webContents) rendererReady?.resolve()
    if (typeof next !== 'object' || next === null) return
    const clean = sanitizeState(next as Record<string, unknown>)
    if (sameState(state, clean)) return
    state = clean
    for (const listener of listeners) listener(state)
    scheduleRebuild()
  })
}
