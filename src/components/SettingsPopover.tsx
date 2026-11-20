import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Cloud, FolderPlus, Info, Menu, RefreshCw, Settings, SpellCheck, Type } from 'lucide-react'

/* Settings, in Inkwell's own surface (the sibling of AppearancePopover). On
   Windows there is no menu strip above the app, so what used to live only in
   the Integrations, Edit ▸ Spelling and Help menus is here: the integrations,
   spelling, updates, About, and a way to the whole application menu.

   Trust: this panel cannot turn an integration on. The Agent and Ephy
   switches REQUEST it (`requestEnable`); main then asks in a native dialog and
   the switch moves only when main says the setting changed
   (`agent:enabled-changed` / `ephy:enabled-changed`, mirrored by App). Turning
   one off, spelling and the update check are plain settings. App owns `open`
   (Escape closes it first). */

export type SettingsProps = {
  open: boolean
  setOpen: (open: boolean | ((current: boolean) => boolean)) => void
  agentEnabled: boolean
  ephyEnabled: boolean
  /** The library has no folder, so the agent has nowhere to save a new note. */
  needsNotesFolder: boolean
  onOpenAppearance: () => void
  onCheckForUpdates: () => void
  /** Pops the application menu up below the header (CSS px). */
  onAllCommands: (at: { x: number; y: number }) => void
}

type Props = SettingsProps & {
  /** Late header stages move Settings into the ⋯ menu. The panel itself stays
      mounted here so the menu can still open it. */
  hideButton?: boolean
}

function Switch({ icon, label, hint, checked, pending, onToggle }: {
  icon?: ReactNode
  label: string
  hint?: string
  checked: boolean
  /** Main is asking the person; the switch has not moved yet. */
  pending?: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-busy={pending || undefined} className="settings-switch" onClick={onToggle}>
      {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
      <span className="settings-row-text">
        <strong>{label}</strong>
        {hint && <small>{pending ? 'Waiting for your answer…' : hint}</small>}
      </span>
      <span className="settings-switch-track" aria-hidden="true"><span /></span>
    </button>
  )
}

export function SettingsPopover(props: Props) {
  const { open, setOpen, agentEnabled, ephyEnabled, needsNotesFolder, hideButton } = props
  const control = useRef<HTMLDivElement>(null)
  const [spellcheck, setSpellcheck] = useState(true)
  const [autoCheck, setAutoCheck] = useState(true)
  const [includeNote, setIncludeNote] = useState(true)
  const [asking, setAsking] = useState<'agent' | 'ephy' | null>(null)

  /* Main owns every one of these; read once, then follow its change events. */
  useEffect(() => {
    const bridge = window.inkwell
    if (!bridge) return
    void bridge.spellcheck?.get().then(setSpellcheck).catch(() => undefined)
    void bridge.update?.getAutoCheck().then(setAutoCheck).catch(() => undefined)
    void bridge.agent?.getIncludeNote().then(setIncludeNote).catch(() => undefined)
    const offSpelling = bridge.spellcheck?.onChange?.(setSpellcheck)
    const offAutoCheck = bridge.update?.onAutoCheckChange?.(setAutoCheck)
    const offIncludeNote = bridge.agent?.onIncludeNoteChange?.(setIncludeNote)
    return () => {
      offSpelling?.()
      offAutoCheck?.()
      offIncludeNote?.()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside)
    return () => window.removeEventListener('pointerdown', closeOutside)
  }, [open, setOpen])

  /* On: ask main, which asks the person. Off: just off. */
  const toggleIntegration = (kind: 'agent' | 'ephy', enabled: boolean) => {
    const bridge = window.inkwell?.[kind]
    if (!bridge || asking) return
    if (enabled) {
      void bridge.disable().catch(() => undefined)
      return
    }
    setAsking(kind)
    void bridge.requestEnable().catch(() => false).finally(() => setAsking(null))
  }

  const allCommands = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setOpen(false)
    props.onAllCommands({ x: rect.left, y: rect.top })
  }

  return (
    <div className={`settings-control ${hideButton ? 'settings-buttonless' : ''}`} ref={control}>
      {!hideButton && (
        <button
          className="icon-button settings-button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Settings: integrations, spelling and updates"
          onClick={() => setOpen((current) => !current)}
        >
          <Settings size={18} strokeWidth={1.7} />
        </button>
      )}
      {open && (
        <div className="settings-panel" role="dialog" aria-label="Settings">
          <p className="appearance-heading"><Settings size={15} strokeWidth={1.8} /> Settings</p>

          <section aria-labelledby="settings-integrations">
            <h2 id="settings-integrations">Integrations</h2>
            <Switch
              icon={<Bot size={16} strokeWidth={1.7} />}
              label="Agent"
              hint="A coding agent beside your notes. Inkwell asks before turning it on."
              checked={agentEnabled}
              pending={asking === 'agent'}
              onToggle={() => toggleIntegration('agent', agentEnabled)}
            />
            {agentEnabled && (
              <div className="settings-nested">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={includeNote}
                    onChange={(event) => {
                      const on = event.target.checked
                      setIncludeNote(on)
                      void window.inkwell?.agent.setIncludeNote(on).then(setIncludeNote).catch(() => undefined)
                    }}
                  />
                  Include current note
                </label>
                {needsNotesFolder && (
                  <button type="button" className="settings-link" onClick={() => { void window.inkwell?.agent.addNotesFolder().catch(() => undefined) }}>
                    <FolderPlus size={14} strokeWidth={1.8} /> Add Notes Folder…
                  </button>
                )}
              </div>
            )}
            <Switch
              icon={<Cloud size={16} strokeWidth={1.7} />}
              label="Ephy"
              hint="Open and publish notes with the ephy command-line tool."
              checked={ephyEnabled}
              pending={asking === 'ephy'}
              onToggle={() => toggleIntegration('ephy', ephyEnabled)}
            />
          </section>

          <section aria-labelledby="settings-spelling">
            <h2 id="settings-spelling">Spelling</h2>
            <Switch
              icon={<SpellCheck size={16} strokeWidth={1.7} />}
              label="Check spelling while typing"
              checked={spellcheck}
              onToggle={() => { void window.inkwell?.spellcheck.set(!spellcheck).then(setSpellcheck).catch(() => undefined) }}
            />
          </section>

          <section aria-labelledby="settings-updates">
            <h2 id="settings-updates">Updates</h2>
            <Switch
              icon={<RefreshCw size={16} strokeWidth={1.7} />}
              label="Check automatically"
              hint="Once a day, against GitHub Releases."
              checked={autoCheck}
              onToggle={() => { void window.inkwell?.update.setAutoCheck(!autoCheck).then(setAutoCheck).catch(() => undefined) }}
            />
            <button type="button" className="settings-action" onClick={() => { setOpen(false); props.onCheckForUpdates() }}>
              Check for Updates…
            </button>
          </section>

          <div className="settings-links">
            <button type="button" className="settings-link" onClick={() => { setOpen(false); props.onOpenAppearance() }}>
              <Type size={14} strokeWidth={1.8} /> Appearance…
            </button>
            <button type="button" className="settings-link" title="File, Edit, View, Integrations and Help (Alt or F10)" onClick={allCommands}>
              <Menu size={14} strokeWidth={1.8} /> All menu commands…
            </button>
            <button type="button" className="settings-link" onClick={() => { setOpen(false); window.inkwell?.showAbout() }}>
              <Info size={14} strokeWidth={1.8} /> About Inkwell
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
