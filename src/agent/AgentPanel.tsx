import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, MessageSquarePlus, Send, Square, X } from 'lucide-react'
import type {
  AgentBufferRequest,
  AgentHarnessId,
  AgentHarnessInfo,
  AgentPermissionRequest,
  AgentSessionState,
  AgentTranscriptEntry
} from '../../src-electron/ipc/contract'
import { useActiveDocument } from '../app/activeDocument'
import { useIntegrations } from '../app/integrations'
import { DRAFTS } from '../lib/library'
import { fileNameFor, samePath } from '../lib/paths'
import { Dialog } from './Dialog'
import { EntryView } from './Transcript'
import { reveal, withMarkdownName } from './reveal'
import './AgentPanel.css'

/* The agent panel (ACP). Owned by the agent workstream (G); everything under
   src/agent/ is G's.

   App renders this inside `<aside className="agent-panel">`, the grid's
   fourth track, and keeps it MOUNTED while hidden (the aside is display:none
   when collapsed), so a session keeps running and still answers buffer
   requests with the panel closed. `open` says whether it is on screen. All
   state lives in main (window.inkwell.agent); this component mirrors it from
   `agent:event`s, and the enable toggle from IntegrationsContext (pushed on
   `agent:enabled-changed`). The chosen harness and "Include current note" are
   main's settings too, never browser storage. Permission and link sheets are
   portalled to <body>. */

export type AgentPanelProps = {
  open: boolean
  onClose: () => void
}

const MAX_ENTRIES = 1000
const FALLBACK_TITLES: Record<AgentHarnessId, string> = { kiro: 'Kiro CLI', codex: 'Codex', claude: 'Claude Code' }
const HARNESS_ORDER: AgentHarnessId[] = ['kiro', 'codex', 'claude']

const isBusy = (state: AgentSessionState) => state.state === 'starting' || state.state === 'prompting'
const isLive = (state: AgentSessionState) => state.state === 'starting' || state.state === 'ready' || state.state === 'prompting'

function dotClass(state: AgentSessionState): string {
  switch (state.state) {
    case 'ready': return 'ready'
    case 'starting':
    case 'prompting': return 'working'
    case 'failed': return 'failed'
    default: return 'idle'
  }
}

function statusLine(state: AgentSessionState): string {
  switch (state.state) {
    case 'disabled': return 'Off'
    case 'stopped': return 'Not started'
    case 'starting': return 'Starting…'
    case 'ready': return state.agentTitle ? `Connected · ${reveal(state.agentTitle)}` : 'Connected'
    case 'prompting': return 'Working…'
    case 'failed': return 'Not connected'
  }
}

export function AgentPanel({ open, onClose }: AgentPanelProps) {
  const agent = window.inkwell?.agent
  const { doc } = useActiveDocument()
  const { documents, applyEditTo, setAgentOpen, agentEnabled } = useIntegrations()

  const [state, setState] = useState<AgentSessionState>({ state: 'stopped' })
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([])
  const [harnesses, setHarnesses] = useState<AgentHarnessInfo[]>([])
  const [chosen, setChosen] = useState<AgentHarnessId>('kiro')
  const [includeNote, setIncludeNote] = useState(true)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [permissions, setPermissions] = useState<AgentPermissionRequest[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [hasPrompted, setHasPrompted] = useState(false)
  const everStarted = useRef(false)

  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const applyEditToRef = useRef(applyEditTo)
  applyEditToRef.current = applyEditTo

  const enabled = state.state !== 'disabled'
  const running = isLive(state)
  const harnessTitle = (id: AgentHarnessId) => harnesses.find((entry) => entry.id === id)?.title ?? FALLBACK_TITLES[id]
  const info = (id: AgentHarnessId) => harnesses.find((entry) => entry.id === id)

  /* Main's state, events and the open-note buffer. */
  useEffect(() => {
    if (!agent) return undefined
    const subscriptions: Array<() => void> = []
    subscriptions.push(agent.onEvent((event) => {
      if (event.type === 'reset') {
        setEntries([])
        setPermissions([])
        setNotice('')
        setHasPrompted(false)
      } else if (event.type === 'entry') {
        setEntries((current) => {
          const next = current.slice()
          const index = next.findIndex((entry) => entry.id === event.entry.id)
          if (index >= 0) next[index] = event.entry
          else next.push(event.entry)
          return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
        })
        if (event.entry.kind === 'user') setHasPrompted(true)
      } else {
        setState(event.state)
        if (event.state.state === 'starting' || event.state.state === 'ready' || event.state.state === 'prompting') {
          everStarted.current = true
          const id = 'harness' in event.state ? event.state.harness : undefined
          if (id) setChosen(id)
        }
        if (event.state.state === 'disabled') everStarted.current = false
        // A sheet belongs to a turn; when the turn is over it is moot.
        if (event.state.state !== 'prompting') setPermissions([])
      }
    }))
    subscriptions.push(agent.onPermissionRequest((request) => {
      setPermissions((current) => [...current, request])
      setAgentOpen(true)
    }))
    subscriptions.push(agent.onBufferRequest((request: AgentBufferRequest) => {
      const docs = documentsRef.current
      const wanted = fileNameFor(request.path).toLowerCase()
      /* An unsaved draft has no path: main offers it at a stand-in path under
         its name, and names it exactly by id when the prompt carried one. A
         path main sends for ANY open note is the renderer's own spelling
         (main maps real paths back, acp/spellings.ts), so samePath is
         enough for files. */
      const match = request.draft
        ? request.docId
          ? docs.find((entry) => entry.id === request.docId && !entry.path)
          : docs.find((entry) => !entry.path && entry.sourceId === DRAFTS && withMarkdownName(entry.name).toLowerCase() === wanted)
        : docs.find((entry) => entry.path && samePath(entry.path, request.path))
      if (!match) {
        agent.respondBuffer({ requestId: request.requestId, open: false })
      } else if (request.op === 'read') {
        agent.respondBuffer({ requestId: request.requestId, open: true, content: match.content })
      } else {
        agent.respondBuffer({ requestId: request.requestId, open: true, applied: applyEditToRef.current(match.id, request.content) })
      }
    }))
    void agent.getState().then((next) => {
      setState(next)
      if (isLive(next)) everStarted.current = true
    })
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [agent, setAgentOpen])

  /* The toggle can flip from the menu at any time; main also sends a state
     event, but the pushed flag is the one source every surface shares. */
  useEffect(() => {
    setState((current) => {
      if (!agentEnabled) return current.state === 'disabled' ? current : { state: 'disabled' }
      return current.state === 'disabled' ? { state: 'stopped' } : current
    })
  }, [agentEnabled])

  /* The persisted "Include current note". */
  useEffect(() => {
    void agent?.getIncludeNote?.().then(setIncludeNote).catch(() => undefined)
  }, [agent])

  const refreshHarnesses = useCallback(() => {
    void agent?.listHarnesses().then((list) => {
      setHarnesses(list)
      const selected = list.find((entry) => entry.selected)
      // A live session names its own harness; otherwise show the saved choice.
      if (selected) setChosen((current) => (everStarted.current ? current : selected.id))
    })
  }, [agent])

  useEffect(() => {
    if (enabled) refreshHarnesses()
    else setHarnesses([])
  }, [enabled, refreshHarnesses])

  /* Showing the panel starts a session, once, like the Mac. After a Stop it
     stays stopped until asked. */
  useEffect(() => {
    if (open && agent && state.state === 'stopped' && !everStarted.current) {
      everStarted.current = true
      void agent.newSession()
    }
  }, [open, agent, state.state])

  /* Keep the newest line in view unless the reader scrolled up. */
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [entries, state])
  const onScroll = () => {
    const element = scroller.current
    if (element) stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }

  const requestLink = useCallback((url: string) => setLink(url), [])

  const answer = (request: AgentPermissionRequest, optionId: string | null) => {
    agent?.respondPermission({ requestId: request.requestId, optionId })
    setPermissions((current) => current.filter((entry) => entry.requestId !== request.requestId))
  }

  const send = async () => {
    const text = draft.trim()
    if (!agent || !text || isBusy(state)) return
    setDraft('')
    setNotice('')
    stuck.current = true
    const note = doc
      ? { name: doc.name, path: doc.path, content: doc.content, unsaved: !doc.path && doc.sourceId === DRAFTS, docId: doc.id }
      : undefined
    const result = await agent.prompt({ text, includeNote, note })
    if (!result.ok) setNotice(result.message)
  }

  const choose = (id: AgentHarnessId) => {
    setMenuOpen(false)
    if (!agent || id === chosen && running) return
    if (info(id) && !info(id)?.installed) return
    setChosen(id)
    void agent.start(id).then((result) => { if (!result.ok) setNotice(result.message) })
  }

  const missing = useMemo(() => harnesses.filter((entry) => !entry.installed), [harnesses])
  const current = 'harness' in state ? state.harness : chosen

  if (!agent) {
    return <div className="agent-panel-body"><p className="agent-panel-empty">The agent panel needs the Inkwell desktop app.</p></div>
  }

  const header = (
    <div className="agent-panel-heading">
      <span className={`agent-dot ${dotClass(state)}`} aria-hidden="true" />
      <div className="agent-heading-text">
        {enabled ? (
          <div
            className="agent-picker"
            onKeyDown={(event) => {
              /* Like the row menu: while the harness menu is open, Escape
                 (from the picker button or an item) closes it and must not
                 fall through to the window handler (focus mode, outline). */
              if (event.key !== 'Escape' || !menuOpen) return
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(false)
            }}
          >
            <button
              type="button"
              className="agent-picker-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen((value) => !value); refreshHarnesses() }}
            >
              {harnessTitle(current)} <ChevronDown size={12} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="agent-menu" role="menu">
                {HARNESS_ORDER.map((id) => {
                  const entry = info(id)
                  const absent = entry !== undefined && !entry.installed
                  const live = running && 'harness' in state && state.harness === id
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={id === current}
                      className="agent-menu-item"
                      disabled={absent}
                      onClick={() => choose(id)}
                    >
                      <span className={`agent-dot ${live ? 'working' : absent ? 'missing' : 'available'}`} aria-hidden="true" />
                      <span>{harnessTitle(id)}</span>
                      <em>{live ? 'running' : absent ? 'not installed' : 'available'}</em>
                    </button>
                  )
                })}
                {missing.length > 0 && <div className="agent-menu-rule" />}
                {missing.map((entry) => (
                  <button key={entry.id} type="button" role="menuitem" className="agent-menu-item help" onClick={() => { setMenuOpen(false); agent.openHarnessHelp(entry.id) }}>
                    Install help for {entry.title}…
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <strong className="agent-title"><Bot size={14} aria-hidden="true" /> Agent</strong>
        )}
        <span className="agent-status">{state.state === 'failed' ? 'Not connected' : statusLine(state)}</span>
      </div>
      <button className="icon-button" aria-label="New agent session" title="New agent session" disabled={!enabled || state.state === 'starting'} onClick={() => void agent.newSession()}>
        <MessageSquarePlus size={16} />
      </button>
      <button className="icon-button" aria-label="Stop agent" title="Stop agent" disabled={!running} onClick={() => agent.stop()}>
        <Square size={14} />
      </button>
      <button className="icon-button" aria-label="Hide agent panel" title="Agent panel (Ctrl+Alt+A)" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  )

  const sheet = permissions[0]
  const sheets = (
    <>
      {sheet && (
        <Dialog
          key={sheet.requestId}
          title={sheet.kind === 'write' ? sheet.title : `${harnessTitle(current)} asks permission`}
          wide={sheet.kind === 'write'}
          onDismiss={() => answer(sheet, sheet.options.find((option) => option.kind === 'reject_once')?.optionId
            ?? sheet.options.find((option) => option.kind === 'reject_always')?.optionId ?? null)}
          buttons={[
            // Rejects first: Esc and the initial focus land on the safest choice.
            ...[...sheet.options]
              .sort((a, b) => Number(b.kind.startsWith('reject')) - Number(a.kind.startsWith('reject')))
              .map((option, index) => ({
                label: reveal(option.name),
                onClick: () => answer(sheet, option.optionId),
                safe: index === 0 && option.kind.startsWith('reject'),
                primary: option.kind === 'allow_once'
              }))
          ]}
        >
          {sheet.kind === 'tool' && <p className="agent-dialog-lead">The agent wrote: “{reveal(sheet.title)}”</p>}
          {sheet.path && <p className="agent-dialog-path">{reveal(sheet.path)}</p>}
          {sheet.detail && <p className={sheet.kind === 'tool' ? 'agent-dialog-detail' : 'agent-dialog-lead'}>{reveal(sheet.detail)}</p>}
          {sheet.diff && (
            <pre className="agent-diff" aria-label="Proposed changes" tabIndex={0}>
              {sheet.diff.slice(0, 2000).map((line, index) => (
                <span key={index} className={`diff-${line.op}`}>
                  {line.op === 'keep' ? '  ' : line.op === 'add' ? '+ ' : line.op === 'remove' ? '- ' : '… '}
                  {reveal(line.text)}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </Dialog>
      )}
      {link && (
        <Dialog
          title="Open this link from the agent?"
          onDismiss={() => setLink(null)}
          buttons={[
            { label: 'Cancel', onClick: () => setLink(null), safe: true },
            {
              label: 'Open',
              primary: true,
              onClick: () => {
                // Main's window-open policy hands http(s) to the desktop browser.
                window.open(link, '_blank', 'noopener,noreferrer')
                setLink(null)
              }
            }
          ]}
        >
          <p className="agent-dialog-path">{reveal(link)}</p>
        </Dialog>
      )}
    </>
  )

  if (!enabled) {
    return (
      <div className="agent-panel-body">
        {header}
        <p className="agent-panel-empty">
          The agent is turned off. Turn it on from the Integrations menu to chat with Kiro CLI, Codex or Claude Code
          about your notes. Nothing is started until you do.
        </p>
        {sheets}
      </div>
    )
  }

  return (
    <div className="agent-panel-body">
      {header}
      <div className="agent-transcript" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label="Agent conversation">
        {entries.length === 0 && (
          <p className="agent-panel-empty">
            {state.state === 'failed'
              ? reveal(state.message)
              : 'Ask about the open note. The agent sees it when “Include current note” is on.'}
          </p>
        )}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} harness={harnessTitle(current)} onLink={requestLink} />
        ))}
      </div>
      {notice && <p className="agent-notice" role="alert">{reveal(notice)}</p>}
      <div className="agent-composer">
        <textarea
          aria-label="Message to the agent"
          placeholder="Ask the agent"
          rows={2}
          value={draft}
          disabled={state.state === 'starting' || state.state === 'prompting'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter adds a line; never mid-composition (IME).
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="agent-composer-row">
          <label className="agent-include" title="Send the open note with the first message of a session">
            <input
              type="checkbox"
              checked={includeNote}
              disabled={hasPrompted && running}
              onChange={(event) => {
                const on = event.target.checked
                setIncludeNote(on)
                void agent.setIncludeNote(on).then(setIncludeNote).catch(() => undefined)
              }}
            />
            Include current note
          </label>
          {state.state === 'prompting' ? (
            <button type="button" className="agent-button" title="Stop this turn (session/cancel)" onClick={() => agent.cancel()}>Cancel</button>
          ) : (
            <button type="button" className="agent-button primary" disabled={!draft.trim() || state.state === 'starting'} onClick={() => void send()}>
              <Send size={12} aria-hidden="true" /> Send
            </button>
          )}
        </div>
      </div>
      {sheets}
    </div>
  )
}
