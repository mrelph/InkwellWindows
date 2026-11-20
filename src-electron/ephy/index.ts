import { shell, type BrowserWindow } from 'electron'
import { handle } from '../ipcGuard'
import { getSetting, setSetting } from '../settings'
import type { EphyLatest, EphyListPage, EphyResult, EphyStatus } from '../ipc/contract'
import { EphyClient } from './client'
import { EphyError, MAX_LIST_LIMIT, PAGE_SIZE, defaultMessage, isValidId } from './core'
import { runProcess } from './launcher'
import { findEphy } from './locate'

/* Ephy: an artifact store reached only through the `ephy` CLI (and `mwinit`
   for sign-in) — the port of InkwellMac Sources/InkwellCore/Ephy.swift and
   Integrations/EphyController.swift. Owned by the Ephy workstream (H);
   everything under src-electron/ephy/ is H's.

   - Off by default. While disabled every call answers `disabled` and no
     process is started.
   - The CLI runs with an argument array, never a shell string (a .cmd shim
     goes through cmd.exe with sanitised arguments, see launcher.ts); ids are
     checked against ^[A-Za-z0-9]{6,40}$ before any process starts.
   - Note content goes over stdin/stdout only; never written to disk or logged.
   - Ephy notes are in-memory documents in the renderer: never in library.json,
     never in Recent. Only local-file links ({ id, title, version }) persist.
   - openInBrowser asks the CLI for the viewer URL, then opens it only if it
     is https; the renderer never supplies a URL.
   - mwinit is never run from here: an expired Midway session surfaces as the
     `signedOut` error and the UI tells the person to run it themselves. */

let registered = false
let current: BrowserWindow | null = null
let executable: string | null = null

/** Content ceiling for one save, so a runaway renderer cannot pipe gigabytes. */
const MAX_CONTENT_CHARS = 20_000_000

export function isEphyEnabled(): boolean {
  return getSetting('ephyEnabled')
}

/** Main-only: called from the Integrations menu, never from the renderer (a
    compromised page must not be able to publish as the user). */
export function setEphyEnabled(on: boolean): boolean {
  return setSetting('ephyEnabled', on === true)
}

/** The CLI's path, found once and remembered; a failed launch forgets it so a
    later install is noticed. */
function locate(): string | null {
  if (executable) return executable
  executable = findEphy()
  return executable
}

function client(): EphyClient {
  if (!isEphyEnabled()) throw new EphyError('disabled')
  const found = locate()
  if (!found) throw new EphyError('notFound')
  return new EphyClient({ executable: found, launcher: runProcess, isEnabled: isEphyEnabled })
}

/** Runs one operation and turns any failure into the contract's result. */
async function answer<T>(operation: (client: EphyClient) => Promise<T>): Promise<EphyResult<T>> {
  try {
    return { ok: true, value: await operation(client()) }
  } catch (error) {
    if (error instanceof EphyError) {
      if (error.code === 'notFound') executable = null
      return { ok: false, error: error.code, message: error.message }
    }
    // Never echo the raw error: it could carry text the CLI printed.
    return { ok: false, error: 'failed', message: defaultMessage('failed') }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const invalid = <T>(): EphyResult<T> => ({ ok: false, error: 'invalidId', message: defaultMessage('invalidId') })

const bad = <T>(message: string): EphyResult<T> => ({ ok: false, error: 'failed', message })

/** The picker's cursor is the size of the next page: the CLI has no cursor,
    so (as on the Mac) "more" is a bigger `--limit`. */
function pageLimit(request: unknown): number {
  const body = isRecord(request) ? request : {}
  if (typeof body.cursor === 'string' && /^\d{1,5}$/.test(body.cursor)) return Number.parseInt(body.cursor, 10)
  if (typeof body.limit === 'number' && Number.isFinite(body.limit)) return body.limit
  return PAGE_SIZE
}

async function status(): Promise<EphyStatus> {
  if (!isEphyEnabled()) return { enabled: false, cliFound: false, sessionValid: null }
  executable = null
  const found = locate()
  if (!found) {
    return { enabled: true, cliFound: false, sessionValid: null, message: defaultMessage('notFound') }
  }
  // The smallest read there is: one row. Signed out shows up in stderr.
  const probe = await answer((c) => c.list(1))
  if (probe.ok) return { enabled: true, cliFound: true, cliPath: found, sessionValid: true }
  if (probe.error === 'signedOut') return { enabled: true, cliFound: true, cliPath: found, sessionValid: false, message: probe.message }
  return { enabled: true, cliFound: true, cliPath: found, sessionValid: null, message: probe.message }
}

/** Registers once; later calls rebind the window. */
export function registerEphyIpc(window: BrowserWindow): void {
  current = window
  if (registered) return
  registered = true

  handle('ephy:get-enabled', () => isEphyEnabled())
  handle('ephy:status', () => status())

  handle('ephy:list', async (_event, request: unknown): Promise<EphyResult<EphyListPage>> => {
    return answer(async (c) => {
      const page = await c.list(Math.min(pageLimit(request), MAX_LIST_LIMIT))
      // Worth offering more only if this page came back full.
      const more = page.rawCount >= page.limit && page.limit < MAX_LIST_LIMIT
      return { artifacts: page.artifacts, ...(more ? { nextCursor: String(Math.min(page.limit + PAGE_SIZE, MAX_LIST_LIMIT)) } : {}) }
    })
  })

  handle('ephy:open', async (_event, id: unknown) => {
    if (!isValidId(id)) return invalid()
    return answer((c) => c.get(id))
  })

  handle('ephy:get-latest', async (_event, request: unknown): Promise<EphyResult<EphyLatest>> => {
    const body = isRecord(request) ? request : {}
    if (!isValidId(body.id)) return invalid()
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : undefined
    const id = body.id
    return answer((c) => c.latest(id, version))
  })

  handle('ephy:save', async (_event, request: unknown): Promise<EphyResult<{ version?: number }>> => {
    const body = isRecord(request) ? request : {}
    if (!isValidId(body.id)) return invalid()
    if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT_CHARS) return bad('That note is too large to save to Ephy.')
    const baseVersion = typeof body.baseVersion === 'number' && Number.isInteger(body.baseVersion) && body.baseVersion >= 0 ? body.baseVersion : undefined
    const { id, content } = body
    return answer(async (c) => {
      const version = await c.update(id, content, baseVersion)
      return version === undefined ? {} : { version }
    })
  })

  handle('ephy:save-as-new', async (_event, request: unknown): Promise<EphyResult<{ id: string; version?: number }>> => {
    const body = isRecord(request) ? request : {}
    if (typeof body.title !== 'string' || typeof body.content !== 'string' || body.content.length > MAX_CONTENT_CHARS) {
      return bad('That note cannot be saved to Ephy.')
    }
    const { title, content } = body
    return answer((c) => c.create(title, content))
  })

  handle('ephy:open-in-browser', async (_event, id: unknown): Promise<EphyResult<null>> => {
    if (!isValidId(id)) return invalid()
    const result = await answer((c) => c.viewerUrl(id))
    if (!result.ok) return result
    try {
      await shell.openExternal(result.value)
    } catch {
      return bad("Windows couldn't open the link.")
    }
    return { ok: true, value: null }
  })
}

/** For tests and diagnostics: the window Ephy last bound to. */
export function ephyWindow(): BrowserWindow | null {
  return current
}
