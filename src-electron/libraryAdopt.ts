import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { on } from './ipcGuard'
import type { FolderResult, LibraryAdoptRequest } from './ipc/contract'

/* Main asking the renderer to add a library folder main itself chose (the
   agent's notes-folder offer). The renderer owns the library list, so main
   sends `library:adopt-folder` with the folder and what is in it, and waits
   for `library:adopt-folder-result`.

   Trust never travels through here. By the time the request goes out main has
   already trusted the folder (trustedDocuments.trustLibraryFolder), and the
   reply only says whether the renderer took it. A reply for a request main did
   not make is ignored, and the sender check (ipcGuard.ts) already limits it to
   the app's own page. */

const REPLY_TIMEOUT_MS = 15_000

const pending = new Map<string, (ok: boolean) => void>()
let registered = false
let current: BrowserWindow | null = null

/** Registers once; later calls rebind the window requests are sent to. */
export function registerLibraryAdopt(window: BrowserWindow): void {
  current = window
  if (registered) return
  registered = true
  on('library:adopt-folder-result', (event, response: unknown) => {
    if (!current || current.isDestroyed() || event.sender !== current.webContents) return
    const record = typeof response === 'object' && response !== null ? response as Record<string, unknown> : {}
    const resolve = typeof record.requestId === 'string' ? pending.get(record.requestId) : undefined
    if (!resolve || typeof record.requestId !== 'string') return
    pending.delete(record.requestId)
    resolve(record.ok === true)
  })
}

/** Asks the renderer to add `result.folder` to the library, exactly as File ▸
    Add Folder does. True once it is in the renderer's library and its agent
    context has been sent (those arrive before this answer). False when the
    renderer declined (overlap, limit), did not answer, or there is no window. */
export function adoptFolderInRenderer(result: FolderResult): Promise<boolean> {
  const window = current
  if (!window || window.isDestroyed() || !result.folder) return Promise.resolve(false)
  const requestId = randomUUID()
  const request: LibraryAdoptRequest = { requestId, result }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(false)
    }, REPLY_TIMEOUT_MS)
    pending.set(requestId, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    window.webContents.send('library:adopt-folder', request)
  })
}
