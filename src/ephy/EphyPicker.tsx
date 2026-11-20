import { Cloud, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EphyArtifact } from '../../src-electron/ipc/contract'
import { runCommand, useCommand } from '../app/commands'
import { useActiveDocument } from '../app/activeDocument'
import { useIntegrations } from '../app/integrations'
import type { MarkdownDoc } from '../lib/library'
import { EphyDialog } from './EphyDialog'
import { getLatest, openArtifact, openInBrowser, saveActiveToEphy, saveAsNew, type PickerFailure } from './ephyClient'
import { bindHost, type DialogResult, type DialogSpec } from './ephyHost'
import { filterArtifacts, relativeTime } from './ephyLogic'
import './EphyPicker.css'

/* Ephy UI. Owned by the Ephy workstream (H).

   EphyPicker is mounted once by App, outside the layout grid, whatever the
   state. It registers the 'ephyOpen' | 'ephySave' | 'ephySaveAsNew' |
   'ephyOpenInBrowser' | 'ephyGetLatest' commands, binds the library to the
   Ephy flows (ephyClient.ts), and draws the picker and the confirmations. All
   of it is position: fixed — it sits beside the grid, never in it. While Ephy
   is off every command does nothing and nothing is drawn. */

/** The toggle lives in main (Integrations ▸ Ephy). App mirrors it into
    IntegrationsContext from `ephy:enabled-changed`, so every surface follows
    the menu at once. */
export const useEphyEnabled = (): boolean => useIntegrations().ephyEnabled

type PickerState = {
  artifacts: EphyArtifact[]
  nextCursor?: string
  loading: boolean
  failure: PickerFailure | null
}

const EMPTY: PickerState = { artifacts: [], loading: false, failure: null }

export function EphyPicker() {
  const integrations = useIntegrations()
  const active = useActiveDocument()
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<{ spec: DialogSpec; resolve: (result: DialogResult) => void } | null>(null)

  /* The flows read the library through this ref, so a long CLI call always
     sees the documents as they are when it finishes. */
  const latest = useRef(integrations)
  latest.current = integrations
  const dialogOpen = useRef(false)

  useEffect(() => {
    bindHost({
      ask: (spec) => new Promise<DialogResult>((resolve) => {
        dialogOpen.current = true
        // A question that is still open is answered "no" rather than left hanging.
        setDialog((current) => {
          current?.resolve({ confirmed: false, text: '', checked: false })
          return { spec, resolve }
        })
      }),
      documents: () => latest.current.documents,
      ephyLinks: () => latest.current.ephyLinks,
      addInMemoryDocument: (doc) => latest.current.addInMemoryDocument(doc),
      updateDocument: (id, patch) => latest.current.updateDocument(id, patch),
      rekeyDocument: (oldId, next) => latest.current.rekeyDocument(oldId, next),
      resetUndo: (id) => latest.current.resetUndo(id),
      applyEditTo: (id, text) => latest.current.applyEditTo(id, text),
      setEphyLink: (path, link) => latest.current.setEphyLink(path, link),
      notify: (text) => latest.current.notify(text)
    })
    return () => bindHost(null)
  }, [])

  const activeDoc = (): MarkdownDoc | undefined =>
    active.doc ? latest.current.documents.find((doc) => doc.id === active.doc?.id) : undefined

  /* A switched-off integration never reacts to a key: the pushed flag gates
     every handler, and main refuses every call while off anyway. */
  const gated = (run: () => void | Promise<void>) => async () => {
    if (!latest.current.ephyEnabled) return
    await run()
  }
  const withActive = (run: (doc: MarkdownDoc) => Promise<void>) => gated(async () => {
    const doc = activeDoc()
    if (doc) await run(doc)
  })

  useCommand('ephyOpen', gated(() => { if (!dialogOpen.current) setOpen(true) }))
  useCommand('ephySave', withActive(saveActiveToEphy))
  useCommand('ephySaveAsNew', withActive((doc) => saveAsNew(doc)))
  useCommand('ephyOpenInBrowser', withActive(openInBrowser))
  useCommand('ephyGetLatest', withActive(getLatest))

  const answer = useCallback((result: DialogResult) => {
    setDialog((current) => {
      current?.resolve(result)
      return null
    })
    dialogOpen.current = false
  }, [])

  return (
    <>
      {open ? <PickerDialog onClose={() => setOpen(false)} onOpen={(artifact) => { setOpen(false); void openArtifact(artifact.id) }} /> : null}
      {dialog ? <EphyDialog spec={dialog.spec} onClose={answer} /> : null}
    </>
  )
}

function PickerDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (artifact: EphyArtifact) => void }) {
  const [state, setState] = useState<PickerState>({ ...EMPTY, loading: true })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const load = useCallback(async (cursor?: string) => {
    setState((current) => ({ ...current, loading: true, failure: null }))
    try {
      const result = await window.inkwell!.ephy.list(cursor ? { cursor } : {})
      if (!result.ok) {
        setState((current) => ({ ...current, loading: false, failure: { error: result.error, message: result.message } }))
        return
      }
      setState({ artifacts: result.value.artifacts, nextCursor: result.value.nextCursor, loading: false, failure: null })
    } catch {
      setState((current) => ({ ...current, loading: false, failure: { error: 'failed', message: "Ephy couldn't do that." } }))
    }
  }, [])

  useEffect(() => {
    if (!window.inkwell) {
      setState({ ...EMPTY, failure: { error: 'notImplemented', message: 'Ephy needs the desktop app.' } })
      return
    }
    void load()
  }, [load])

  useEffect(() => { inputRef.current?.focus() }, [])

  const rows = useMemo(() => filterArtifacts(state.artifacts, query), [state.artifacts, query])
  const index = Math.min(selected, Math.max(rows.length - 1, 0))
  const chosen: EphyArtifact | undefined = rows[index]

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, rows])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(Math.min(index + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && chosen && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      onOpen(chosen)
    }
  }

  const signedOut = state.failure?.error === 'signedOut'
  const showEmpty = !state.loading && !state.failure && rows.length === 0

  return (
    <div className="ephy-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="ephy-picker" role="dialog" aria-modal="true" aria-label="Open from Ephy" onKeyDown={onKeyDown}>
        <h2 className="ephy-dialog-title">Open from Ephy</h2>
        <label className="ephy-search">
          <Search size={14} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search your Markdown and text artifacts"
            spellCheck={false}
            aria-label="Search Ephy artifacts"
            onChange={(event) => { setQuery(event.target.value); setSelected(0) }}
          />
        </label>
        <div className="ephy-list-wrap">
          {state.failure ? (
            <div className="ephy-state" role="alert">
              <p>{state.failure.message}</p>
              {signedOut ? <p className="ephy-hint">Inkwell can&apos;t sign you in. Run <code>mwinit</code> in a terminal, then try again.</p> : null}
              <button type="button" className="ephy-button" onClick={() => void load()}>Try Again</button>
            </div>
          ) : state.loading && state.artifacts.length === 0 ? (
            <div className="ephy-state" role="status"><span className="ephy-spinner" aria-hidden /> Loading from Ephy…</div>
          ) : showEmpty ? (
            <div className="ephy-state">{query.trim() === '' ? 'No Markdown or text artifacts yet.' : 'Nothing matches.'}</div>
          ) : (
            <ul ref={listRef} className="ephy-list" role="listbox" aria-label="Ephy artifacts">
              {rows.map((artifact, position) => (
                <li
                  key={artifact.id}
                  role="option"
                  aria-selected={position === index}
                  className={`ephy-row${position === index ? ' is-selected' : ''}`}
                  onClick={() => setSelected(position)}
                  onDoubleClick={() => onOpen(artifact)}
                >
                  <span className="ephy-row-title">{artifact.title}</span>
                  <span className="ephy-row-time">{relativeTime(artifact.updatedAt)}</span>
                </li>
              ))}
              {state.nextCursor && query.trim() === '' ? (
                <li className="ephy-more">
                  <button type="button" className="ephy-button" disabled={state.loading} onClick={() => void load(state.nextCursor)}>Load More</button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <div className="ephy-actions">
          {state.loading && state.artifacts.length > 0 ? <span className="ephy-spinner" role="status" aria-label="Loading" /> : null}
          <span className="ephy-spacer" />
          <button type="button" className="ephy-button" onClick={onClose}>Cancel</button>
          <button type="button" className="ephy-button is-primary" disabled={!chosen} onClick={() => chosen && onOpen(chosen)}>Open</button>
        </div>
      </div>
    </div>
  )
}

/** The empty state's "Open from Ephy" action; only while Ephy is on. */
export function EphyOpenButton() {
  const enabled = useEphyEnabled()
  if (!enabled) return null
  return (
    <button title="Open a Markdown or text artifact from Ephy (Ctrl+Shift+E)" onClick={() => { runCommand('ephyOpen') }}>
      <Cloud size={15} /> Open from Ephy
    </button>
  )
}
