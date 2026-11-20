import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

/* Every renderer → main channel is registered through here, so each one
   checks its sender: the message must come from the app window's MAIN frame,
   and that frame must be showing the app's own page (appOrigin.isAppUrl).
   Anything else — a subframe, a page the window was somehow navigated to, a
   different webContents — is refused: `handle` rejects, `on` is dropped.
   This sits on top of the per-channel payload validation, not instead of it. */

let appWindow: BrowserWindow | null = null
let isApp: (url: string) => boolean = () => false

/** Called by main.ts for each window it creates. */
export function bindAppWindow(window: BrowserWindow, isAppUrl: (url: string) => boolean): void {
  appWindow = window
  isApp = isAppUrl
}

export function isAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const window = appWindow
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false
  const frame = event.senderFrame
  if (!frame) return false
  const main = window.webContents.mainFrame
  if (frame.processId !== main.processId || frame.routingId !== main.routingId) return false
  return isApp(frame.url)
}

export class RefusedSender extends Error {
  constructor(channel: string) {
    super(`${channel} is only available to Inkwell's own window`)
  }
}

/** `ipcMain.handle` with the sender check. */
export function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppSender(event)) throw new RefusedSender(channel)
    return listener(event, ...(args as Args))
  })
}

/** `ipcMain.on` with the sender check. */
export function on<Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isAppSender(event)) return
    listener(event, ...(args as Args))
  })
}
