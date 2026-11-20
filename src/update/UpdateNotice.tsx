import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpCircle, CheckCircle2, Download, Loader2, RotateCw, X } from 'lucide-react'
import './UpdateNotice.css'
import { useCommand } from '../app/commands'
import type { UpdateStatus } from '../../src-electron/ipc/contract'

/* The status bar's update notice, Mac-style and quiet: available → downloading
   N% → ready ("Restart to update") → error (dismissable). It appears only when
   a newer release exists, and the automatic check never announces its own
   failure — offline is the normal state for a local-first editor. "Check for
   Updates…" (the `checkForUpdates` command) is the exception: main answers it
   in a native message box (Mac's alert) — up to date, failed, or "available"
   with Install / Later / Skip This Version — so it is heard even in focus
   mode, where the status bar is hidden. The status bar only shows
   "Checking…" meanwhile and then the outcome's lasting state.

   The page never supplies a URL: it can only ask main to open or install "the
   update"; main builds every address from the release it fetched.

   Download and restart are the two phases of one `update.install()` call:
   the first downloads and verifies (status events drive the percentage), the
   second — after "Restart to update" — runs the installer and quits.

   Renders a single `.statusbar-update` span (or nothing): styles.css relies on
   it being the sibling right before `.statusbar-end`. */

type View =
  | { kind: 'none' }
  | { kind: 'available'; notice: UpdateNotice }
  | { kind: 'downloading'; version: string; progress: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'restarting' }
  | { kind: 'error'; message: string; back: View }
  | { kind: 'info'; message: string; tone: 'busy' | 'ok' }

const INFO_MS = 5000

export function UpdateNotice() {
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const viewRef = useRef<View>(view)
  const lastNotice = useRef<UpdateNotice | null>(null)
  const infoTimer = useRef<number | undefined>(undefined)

  const setView = useCallback((next: View) => {
    viewRef.current = next
    setViewState(next)
  }, [])

  const showAvailable = useCallback((notice: UpdateNotice) => {
    lastNotice.current = notice
    setView({ kind: 'available', notice })
  }, [setView])

  const availableOrNone = (): View =>
    lastNotice.current ? { kind: 'available', notice: lastNotice.current } : { kind: 'none' }

  useEffect(() => {
    const bridge = window.inkwell
    void bridge?.getUpdate?.().then((notice) => {
      if (notice && viewRef.current.kind === 'none') showAvailable(notice)
    }).catch(() => undefined)

    const offAvailable = bridge?.onUpdateAvailable?.((notice) => {
      if (!notice) return
      const kind = viewRef.current.kind
      if (kind === 'none' || kind === 'available' || kind === 'info') showAvailable(notice)
    })

    const offStatus = bridge?.update?.onStatus?.((status: UpdateStatus) => {
      switch (status.state) {
        case 'available': showAvailable(status.notice); break
        case 'downloading': setView({ kind: 'downloading', version: status.version, progress: status.progress }); break
        case 'ready': setView({ kind: 'ready', version: status.version }); break
        case 'error': setView({ kind: 'error', message: status.message, back: availableOrNone() }); break
        case 'idle': setView(availableOrNone()); break
      }
    })

    return () => {
      offAvailable?.()
      offStatus?.()
      window.clearTimeout(infoTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flashInfo = (message: string, tone: 'busy' | 'ok', back: View) => {
    window.clearTimeout(infoTimer.current)
    setView({ kind: 'info', message, tone })
    if (tone === 'ok') {
      infoTimer.current = window.setTimeout(() => {
        if (viewRef.current.kind === 'info') setView(back)
      }, INFO_MS)
    }
  }

  /* Check for Updates…: always answers. Never interrupts a download or a
     pending restart, which are already the answer. */
  useCommand('checkForUpdates', async () => {
    const bridge = window.inkwell?.update
    const kind = viewRef.current.kind
    if (!bridge || kind === 'downloading' || kind === 'ready' || kind === 'restarting') return
    const back: View = kind === 'available' ? viewRef.current : availableOrNone()
    flashInfo('Checking for updates…', 'busy', back)
    try {
      const result = await bridge.check()
      if (result.kind === 'available') {
        if (result.choice === 'skip') {
          // Main has dismissed this version already.
          lastNotice.current = null
          setView({ kind: 'none' })
          return
        }
        showAvailable(result.notice)
        if (result.choice === 'install') void install({ kind: 'available', notice: result.notice }, false)
      } else if (result.kind === 'upToDate') {
        flashInfo(`Inkwell ${result.version} is up to date`, 'ok', back.kind === 'available' ? back : { kind: 'none' })
      } else {
        // The message box said what went wrong; nothing lasting to show.
        setView(back)
      }
    } catch {
      setView({ kind: 'error', message: 'The update check failed.', back: availableOrNone() })
    }
  })

  const install = async (from: View, restarting: boolean) => {
    const bridge = window.inkwell?.update
    if (!bridge) return
    if (restarting) setView({ kind: 'restarting' })
    else setView({ kind: 'downloading', version: from.kind === 'available' ? from.notice.version : '', progress: 0 })
    try {
      const result = await bridge.install()
      if (!result.ok) setView({ kind: 'error', message: result.message, back: restarting ? from : availableOrNone() })
      /* ok: either the verified installer is waiting ('ready' arrived as a
         status), the portable build opened the release page (stays
         'available'), or the app is already quitting. */
    } catch {
      setView({ kind: 'error', message: 'The update could not be installed.', back: restarting ? from : availableOrNone() })
    }
  }

  if (view.kind === 'none') return null

  const dismissButton = (label: string, onClick: () => void) => (
    <button type="button" className="update-dismiss" aria-label={label} title="Dismiss" onClick={onClick}>
      <X size={11} strokeWidth={2} />
    </button>
  )

  switch (view.kind) {
    case 'available': {
      const { notice } = view
      return (
        <span className="statusbar-update" role="status">
          <button
            type="button"
            title={`Inkwell ${notice.version} is out — download and install it`}
            onClick={() => void install(view, false)}
          >
            <ArrowUpCircle size={12} strokeWidth={1.9} /> Inkwell {notice.version} available
          </button>
          <button type="button" className="update-notes" title="Open the release notes on GitHub" onClick={() => window.inkwell?.openUpdate?.()}>
            Notes
          </button>
          {dismissButton(`Dismiss the notice about Inkwell ${notice.version}`, () => {
            window.inkwell?.dismissUpdate?.(notice.version)
            lastNotice.current = null
            setView({ kind: 'none' })
          })}
        </span>
      )
    }
    case 'downloading': {
      const percent = view.progress === null ? null : Math.round(view.progress * 100)
      return (
        <span className="statusbar-update" role="status" aria-live="polite">
          <span className="update-text">
            <Download size={12} strokeWidth={1.9} /> Downloading update{percent === null ? '…' : ` ${percent}%`}
          </span>
        </span>
      )
    }
    case 'ready':
      return (
        <span className="statusbar-update" role="status">
          <button type="button" title="Install Inkwell and reopen it" onClick={() => void install(view, true)}>
            <RotateCw size={12} strokeWidth={1.9} /> Restart to update
          </button>
          {dismissButton('Hide the update notice', () => setView({ kind: 'none' }))}
        </span>
      )
    case 'restarting':
      return (
        <span className="statusbar-update" role="status" aria-live="polite">
          <span className="update-text"><Loader2 size={12} strokeWidth={1.9} className="update-spin" /> Restarting…</span>
        </span>
      )
    case 'error':
      return (
        <span className="statusbar-update update-error" role="alert">
          <span className="update-text" title={view.message}>
            <AlertCircle size={12} strokeWidth={1.9} /> {view.message}
          </span>
          {dismissButton('Dismiss this message', () => setView(view.back))}
        </span>
      )
    case 'info':
      return (
        <span className="statusbar-update" role="status" aria-live="polite">
          <span className="update-text">
            {view.tone === 'busy'
              ? <Loader2 size={12} strokeWidth={1.9} className="update-spin" />
              : <CheckCircle2 size={12} strokeWidth={1.9} />} {view.message}
          </span>
        </span>
      )
  }
}
