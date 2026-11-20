import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { handle, on } from '../ipcGuard'
import { hasUnsavedChanges } from '../unsavedChanges'
import { checkForUpdate, checkNow, dismissUpdate, getAutoCheck, knownUpdate, pendingUpdate, setAutoCheck } from '../update'
import { UpdateInstallError, downloadAndVerify, installAndRelaunch, type PreparedUpdate } from '../updateInstaller'
import type { UpdateCheckResult, UpdateChoice, UpdateInstallResult, UpdateNotice, UpdateStatus } from './contract'

/* Update IPC and the daily schedule. */

let registered = false
let current: BrowserWindow | null = null
let busy = false
let prepared: PreparedUpdate | null = null

const sendStatus = (status: UpdateStatus) => {
  if (current && !current.isDestroyed()) current.webContents.send('update:status', status)
}

/* The portable build has nothing to replace in place: it sends people to the
   release page instead of self-updating. */
const isPortable = () => Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

/** Registers once; later calls rebind the window events are sent to. */
export function registerUpdateIpc(window: BrowserWindow): void {
  current = window
  if (registered) return
  registered = true

  /* Cache only, so a result found in a previous session shows the moment the
     renderer mounts rather than waiting out another check. */
  handle('update:get', () => knownUpdate())

  on('update:dismiss', (_event, version: unknown) => { void dismissUpdate(version) })

  /* The renderer asks to open "the update", never a URL: the address is the
     one main built from the tag it fetched, so nothing in the page can steer
     shell.openExternal somewhere else. */
  on('update:open', () => {
    void pendingUpdate().then((notice) => {
      if (notice) void shell.openExternal(notice.url)
    })
  })

  /* Check for Updates…: a live check that always answers, in a native
     message box like the Mac's alert. The status bar is not enough: focus mode
     hides it, and a manual check that says nothing reads as broken. The
     result still goes back to the renderer, which drives the install (and the
     status-bar progress) when the person chose Install. */
  handle('update:check', async (): Promise<UpdateCheckResult> => {
    let result: UpdateCheckResult
    try {
      result = await checkNow()
    } catch {
      result = { kind: 'failed', message: 'The update check failed.' }
    }
    if (result.kind !== 'available') {
      await showBox(result.kind === 'upToDate'
        ? { type: 'info', title: 'Check for Updates', message: "You're up to date.", detail: `Inkwell ${result.version} is the newest version.`, buttons: ['OK'], noLink: true }
        : { type: 'warning', title: 'Check for Updates', message: "Couldn't check for updates right now.", detail: `${result.message} Try again later.`, buttons: ['OK'], noLink: true })
      return result
    }
    const choice = await askAboutUpdate(result.notice)
    if (choice === 'skip') await dismissUpdate(result.notice.version)
    return { ...result, choice }
  })

  /* Two phases on one channel, so the contract needs nothing new:
       1. nothing downloaded yet → download + verify, status downloading → ready,
          resolve ok (the app keeps running);
       2. a verified installer is waiting → ensure nothing is unsaved, run the
          installer and quit; the installer relaunches Inkwell. */
  handle('update:install', async (): Promise<UpdateInstallResult> => {
    if (busy) return { ok: false, message: 'An update is already in progress.' }
    const notice = await pendingUpdate()
    if (!notice) return { ok: false, message: 'There is no update to install.' }

    /* Nothing to replace in place: the portable build, and a development
       checkout (which is not an installed app), get the release page. */
    if (isPortable() || !app.isPackaged) {
      void shell.openExternal(notice.url)
      return { ok: true }
    }

    busy = true
    try {
      if (prepared && prepared.version === notice.version) {
        if (hasUnsavedChanges()) {
          return { ok: false, message: 'Save or discard your changes, then choose Restart to update again.' }
        }
        await installAndRelaunch(prepared)
        return { ok: true }
      }

      prepared = null
      sendStatus({ state: 'downloading', version: notice.version, progress: 0 })
      prepared = await downloadAndVerify(notice, (progress) =>
        sendStatus({ state: 'downloading', version: notice.version, progress }))
      sendStatus({ state: 'ready', version: prepared.version })
      return { ok: true }
    } catch (error) {
      const message = error instanceof UpdateInstallError ? error.message : 'The update could not be installed.'
      /* A failed restart leaves the verified installer usable; a failed
         download leaves nothing, so the notice falls back to "available". */
      if (!prepared) sendStatus({ state: 'error', message })
      return { ok: false, message }
    } finally {
      busy = false
    }
  })

  handle('update:get-auto-check', () => getAutoCheck())
  handle('update:set-auto-check', (_event, value: unknown) => setAutoCheck(value === true))
}

function showBox(options: MessageBoxOptions) {
  const window = current
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

/** Mac's update alert: install now, later, or skip this version. */
async function askAboutUpdate(notice: UpdateNotice): Promise<UpdateChoice> {
  const portable = isPortable() || !app.isPackaged
  const { response } = await showBox({
    type: 'info',
    title: 'Check for Updates',
    message: `Inkwell ${notice.version} is available.`,
    detail: portable
      ? `You have ${app.getVersion()}. This copy of Inkwell can't replace itself; Download opens the release page.`
      : `You have ${app.getVersion()}. Inkwell will download the update from GitHub, check it, and install it when you choose Restart to update.`,
    buttons: [portable ? 'Download' : 'Install', 'Later', 'Skip This Version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return response === 0 ? 'install' : response === 2 ? 'skip' : 'later'
}

/* The only outbound request Inkwell makes, and the least important thing it
   does: run it well after the window is up so it is never in the launch path,
   then once a day for a session left open across days. It reports only when it
   has something to say — see update.ts for the silence-by-default posture. */
export function scheduleUpdateCheck(window: BrowserWindow): void {
  const run = () => {
    void checkForUpdate().then((notice) => {
      if (notice && !window.isDestroyed()) window.webContents.send('update:available', notice)
    })
  }
  const first = setTimeout(run, 15_000)
  const repeat = setInterval(run, 24 * 60 * 60 * 1000)
  window.on('closed', () => {
    clearTimeout(first)
    clearInterval(repeat)
  })
}
