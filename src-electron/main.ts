import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { isAgentEnabled, registerAgentIpc, shutDownAgent } from './acp'
import { developmentServerUrl, isAppUrl } from './appOrigin'
import { registerAssetProtocol, registerAssetSchemes } from './assets'
import { isSpellcheckEnabled, registerContextMenu } from './contextMenu'
import { isEphyEnabled, registerEphyIpc } from './ephy'
import { documentsFromArgv } from './fileStore'
import { initialiseDocumentTrust, registerDocumentIpc } from './ipc/documents'
import { registerUpdateIpc, scheduleUpdateCheck } from './ipc/update'
import { bindAppWindow, handle, on } from './ipcGuard'
import { registerMenu, sendMenuCommand, whenRendererReady } from './menu'
import { refreshNetworkDrives } from './networkDrives'
import { onSettingChange, type Settings } from './settings'
import { getAppearance, resolveTheme, setAppearance, watchTheme, type ThemeTokens } from './theme'
import { loadState } from './state'
import { trustDocuments } from './trustedDocuments'
import { hasUnsavedChanges, setUnsavedChanges } from './unsavedChanges'
import { getAutoCheck } from './update'

/* main.ts owns the app lifecycle, the window, the unsaved-changes close guard,
   the single-instance lock, argv opening and the external-link policy. Every
   other concern registers itself from its own module (see PARITY.md, "Module
   ownership & contracts"). */

const APP_ID = 'com.inkwell.desktop'

/* Custom schemes must be registered as privileged before the app is ready. */
registerAssetSchemes()

/* Normalise the resolver's tokens into the renderer's payload: metadata split
   from the colors, which are applied wholesale as CSS custom properties. */
const toThemePayload = (tokens: ThemeTokens) => {
  const record = tokens as unknown as Record<string, unknown>
  const nested = record.colors as Record<string, string> | undefined
  const colors = nested ?? Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith('--'))
  ) as Record<string, string>
  return {
    name: String(record.themeName ?? 'default'),
    mode: (record.mode === 'light' ? 'light' : 'dark') as 'light' | 'dark',
    colors
  }
}

let mainWindow: BrowserWindow | null = null

/* The window background is the chrome color, so a theme or mode switch (and
   the frame before the page paints) never flashes the old palette. */
const paintWindow = (window: BrowserWindow, theme: ReturnType<typeof toThemePayload>) => {
  const color = theme.colors['--surface-chrome']
  if (color && !window.isDestroyed()) window.setBackgroundColor(color)
}
let stopWatchingTheme: (() => void) | null = null

/* The jump list's "New note" task (menu.ts) launches Inkwell with this. */
const NEW_NOTE_ARG = '--new-note'
const wantsNewNote = (argv: readonly string[]) => argv.includes(NEW_NOTE_ARG)

/* Files on argv: read them, and vouch for them (they may be saved, and their
   folders count for the asset scheme). Relative paths resolve against the
   working directory of the process that was launched with them — for a
   second instance, the one Electron reports, not this process's own. */
async function argvDocuments(argv: readonly string[], workingDirectory?: string) {
  const documents = await documentsFromArgv(argv.slice(1), workingDirectory)
  trustDocuments(documents, path, { persist: true })
  return documents
}

/* The enable toggles, spellcheck and auto-check: whichever source changes one
   (a menu checkbox, the context menu, a panel's IPC call), the renderer hears
   it on its `*-changed` channel. menu.ts rebuilds from the same signal. */
const SETTING_EVENTS: Partial<Record<keyof Settings, { channel: string; value: () => boolean }>> = {
  agentEnabled: { channel: 'agent:enabled-changed', value: isAgentEnabled },
  ephyEnabled: { channel: 'ephy:enabled-changed', value: isEphyEnabled },
  spellcheck: { channel: 'spellcheck:changed', value: isSpellcheckEnabled },
  autoUpdateCheck: { channel: 'update:auto-check-changed', value: getAutoCheck }
}

/* The built page, or (unpackaged only) a loopback Vite dev server. */
const INDEX_FILE = path.join(__dirname, '../dist/index.html')
const developmentServer = () => developmentServerUrl(process.argv, process.env, app.isPackaged)

async function createWindow() {
  const theme = toThemePayload(await resolveTheme())
  const devServer = developmentServer()

  const window = new BrowserWindow({
    title: 'Inkwell',
    width: 1280,
    height: 860,
    /* Tiling compositors hand a window whatever geometry the layout dictates,
       often a quarter of the screen. Keep the floor low enough that Inkwell
       tiles cleanly instead of forcing the compositor to float it. */
    minWidth: 480,
    minHeight: 360,
    /* Hyprland owns Linux window chrome. Windows keeps its native frame so
       moving, snapping, maximizing, and system-menu behavior all work exactly
       as users expect. */
    frame: process.platform !== 'linux',
    autoHideMenuBar: false,
    backgroundColor: theme.colors['--surface-chrome'] ?? '#f7f3ec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = window
  /* Every IPC handler answers only this window's main frame showing the app. */
  bindAppWindow(window, (url) => isAppUrl(url, { indexFile: INDEX_FILE, devServer }))

  /* Each module registers its IPC once and rebinds to the newest window. */
  registerMenu(window)
  registerContextMenu(window)
  registerUpdateIpc(window)
  registerAgentIpc(window)
  registerEphyIpc(window)

  let allowClose = false
  setUnsavedChanges(false)

  window.on('enter-full-screen', () => window.webContents.send('window:fullscreen-changed', true))
  window.on('leave-full-screen', () => window.webContents.send('window:fullscreen-changed', false))

  /* Markdown can carry arbitrary links. Never navigate the app itself; hand
     safe schemes to the desktop's browser and drop everything else. */
  const openExternally = (url: string) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url)
    } catch {
      /* not a usable URL */
    }
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    openExternally(url)
  })

  window.on('close', (event) => {
    if (!hasUnsavedChanges() || allowClose) return
    event.preventDefault()
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Save your work before closing Inkwell, or discard the changes and close.',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 1) {
      allowClose = true
      window.close()
    }
  })

  window.on('closed', () => {
    shutDownAgent()
    if (mainWindow === window) mainWindow = null
  })

  stopWatchingTheme?.()
  stopWatchingTheme = watchTheme((tokens: ThemeTokens) => {
    if (window.isDestroyed()) return
    const payload = toThemePayload(tokens)
    paintWindow(window, payload)
    window.webContents.send('theme:changed', payload)
  })

  /* An interrupted first navigation (ERR_ABORTED, e.g. the window closed while
     loading) rejects; it is not an error worth an unhandled rejection. */
  const loaded = devServer ? window.loadURL(devServer) : window.loadFile(INDEX_FILE)
  try {
    await loaded
  } catch (error) {
    console.info('Inkwell: the first page load did not finish', (error as Error)?.message ?? error)
    if (window.isDestroyed()) return
  }

  /* Wait for the renderer to be listening: a message sent before App has
     subscribed is dropped. */
  const initial = await argvDocuments(process.argv)
  if (initial.length || wantsNewNote(process.argv)) await whenRendererReady()
  if (initial.length && !window.isDestroyed()) window.webContents.send('document:opened-externally', initial)
  if (wantsNewNote(process.argv)) sendMenuCommand('newNote')

  scheduleUpdateCheck(window)
}

/* A launcher re-invoking Inkwell should raise the existing window and open the
   file in it, not start a second copy with its own unsaved state. */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', async (_event, argv, workingDirectory) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    if (wantsNewNote(argv)) sendMenuCommand('newNote')
    const documents = await argvDocuments(argv, workingDirectory)
    if (documents.length && !mainWindow.isDestroyed()) mainWindow.webContents.send('document:opened-externally', documents)
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
    refreshNetworkDrives()
    /* Main's path authority (trusted documents, library folders) is in place
       before the page can ask for anything. */
    await initialiseDocumentTrust()

    /* Mode and theme from library.json, applied before the window exists. */
    const saved = await loadState()
    setAppearance(saved.appearance, saved.theme)

    handle('theme:get', async () => toThemePayload(await resolveTheme()))

    /* The renderer's choice (menu, Aa panel). Validated against the enums;
       anything else is ignored. Persistence stays the renderer's `state:save`. */
    on('theme:set-appearance', async (_event, choice: unknown) => {
      const { appearance, theme } = (typeof choice === 'object' && choice !== null ? choice : {}) as { appearance?: unknown; theme?: unknown }
      const before = getAppearance()
      if (!setAppearance(appearance, theme)) return
      const after = getAppearance()
      if (before.appearance === after.appearance && before.theme === after.theme) return
      const window = mainWindow
      if (!window || window.isDestroyed()) return
      const payload = toThemePayload(await resolveTheme())
      if (window.isDestroyed()) return
      paintWindow(window, payload)
      window.webContents.send('theme:changed', payload)
    })

    on('document:set-dirty', (_event, isDirty: unknown) => {
      setUnsavedChanges(isDirty)
    })

    onSettingChange((key) => {
      const event = SETTING_EVENTS[key]
      if (event && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event.channel, event.value())
    })

    on('window:toggle-fullscreen', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen())
    })
    handle('window:get-fullscreen', () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()))

    registerAssetProtocol()
    registerDocumentIpc(() => mainWindow)

    void createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('will-quit', () => {
  shutDownAgent()
  stopWatchingTheme?.()
  stopWatchingTheme = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
