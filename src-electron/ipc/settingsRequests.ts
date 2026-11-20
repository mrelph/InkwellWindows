import { dialog, Menu, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { handle, on } from '../ipcGuard'

/* What the header's Settings popover may ask of main. On Windows the menu bar
   is not drawn (Inkwell draws its own title bar), so the integration toggles
   that used to live only in the Integrations menu are reachable from the page
   — without giving the page the power to flip them:

   - ENABLING the agent or Ephy is a request. Main answers it with a native,
     window-modal confirmation that the page cannot see, script or dismiss, and
     enables only on a click on "Turn On". Cancel is the default button, so
     holding Enter never turns anything on. One confirmation at a time: a
     request made while one is open is refused, and a Cancel starts a short
     quiet period, so a compromised page cannot stack or machine-gun dialogs.
   - DISABLING is direct. It only removes capability.
   - `menu:popup` pops the application menu up; every item in it still acts
     only when the person clicks it. `app:about` shows main's About box.

   Electron-light on purpose: everything it needs is passed in, so the handlers
   run under vitest with `electron` and the sender guard stubbed. */

export type IntegrationKind = 'agent' | 'ephy'

export type IntegrationToggle = {
  isEnabled: () => boolean
  /** Main's own setter. Returns the value now in effect. */
  setEnabled: (on: boolean) => boolean
}

export type SettingsRequestDeps = {
  window: () => BrowserWindow | null
  agent: IntegrationToggle & { /** e.g. "Kiro CLI": named in the confirmation. */ harnessTitle: () => string }
  ephy: IntegrationToggle
  showAbout: () => void
  /** Injected in tests. */
  now?: () => number
}

/** After a Cancel, enable requests are refused for this long. */
export const DECLINE_QUIET_MS = 2000

const TURN_ON = 0
const CANCEL = 1

const confirmation = (kind: IntegrationKind, deps: SettingsRequestDeps) => kind === 'agent'
  ? {
      message: 'Turn on the agent?',
      detail: `Inkwell will run ${deps.agent.harnessTitle()} on this computer when you send a prompt. It can read your library folders and the open note's folder, and asks before each change.`
    }
  : {
      message: 'Turn on Ephy?',
      detail: 'Inkwell will run the ephy command-line tool on this computer to open and publish notes under your sign-in.'
    }

/** Where to pop the application menu up, in window DIPs. The renderer sends
    CSS pixels, which page zoom scales; anything that is not a finite point
    inside the content area falls back to the top-left corner. */
export function menuPopupPoint(
  raw: unknown,
  zoomFactor: number,
  content: { width: number; height: number }
): { x: number; y: number } {
  const fallback = { x: 8, y: 8 }
  if (typeof raw !== 'object' || raw === null) return fallback
  const { x, y } = raw as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return fallback
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const clamp = (value: number, max: number) => Math.min(Math.max(0, Math.round(value * zoom)), Math.max(0, Math.round(max)))
  return { x: clamp(x, content.width), y: clamp(y, content.height) }
}

let registered = false
let deps: SettingsRequestDeps | null = null
/** A confirmation is on screen. Shared by both integrations: one at a time. */
let asking = false
let quietUntil = 0
let menuOpen = false

const liveWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null => {
  const window = deps?.window() ?? null
  return window && !window.isDestroyed() && event.sender === window.webContents ? window : null
}

async function requestEnable(kind: IntegrationKind, event: IpcMainInvokeEvent): Promise<boolean> {
  const current = deps
  if (!current) return false
  const target = current[kind]
  if (target.isEnabled()) return true
  const window = liveWindow(event)
  const now = current.now ?? Date.now
  if (!window || asking || now() < quietUntil) return false
  asking = true
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Inkwell',
      ...confirmation(kind, current),
      buttons: ['Turn On', 'Cancel'],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true
    })
    if (response !== TURN_ON) {
      quietUntil = now() + DECLINE_QUIET_MS
      return target.isEnabled()
    }
    return target.setEnabled(true)
  } catch {
    return target.isEnabled()
  } finally {
    asking = false
  }
}

function disable(kind: IntegrationKind, event: IpcMainInvokeEvent): boolean {
  const current = deps
  if (!current) return false
  if (!liveWindow(event)) return current[kind].isEnabled()
  return current[kind].setEnabled(false)
}

/** Registers once; later calls only swap the dependencies (a new window). */
export function registerSettingsRequests(next: SettingsRequestDeps): void {
  deps = next
  if (registered) return
  registered = true

  /* No arguments are read: there is nothing a page could pass that changes
     what is asked or what a click on "Turn On" does. */
  handle('agent:request-enable', (event) => requestEnable('agent', event))
  handle('ephy:request-enable', (event) => requestEnable('ephy', event))
  handle('agent:disable', (event) => disable('agent', event))
  handle('ephy:disable', (event) => disable('ephy', event))

  on('app:about', (event) => {
    if (liveWindow(event)) deps?.showAbout()
  })

  on('menu:popup', (event, at: unknown) => {
    const window = liveWindow(event)
    const menu = Menu.getApplicationMenu()
    if (!window || !menu || menuOpen) return
    const [width, height] = window.getContentSize()
    const point = menuPopupPoint(at, window.webContents.getZoomFactor(), { width, height })
    menuOpen = true
    menu.popup({ window, ...point, callback: () => { menuOpen = false } })
  })
}

/** Test seam: forget the open-dialog and quiet-period state. */
export function resetSettingsRequestsForTest(): void {
  asking = false
  quietUntil = 0
  menuOpen = false
}
