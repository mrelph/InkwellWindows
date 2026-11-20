import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen, Bot, Check, ChevronDown, Cloud, Ellipsis, FileText, Maximize2, Minimize2, PanelLeft,
  PanelRightClose, PanelRightOpen, PencilLine, SaveAll, Settings, SplitSquareHorizontal, Type, ZoomIn, ZoomOut
} from 'lucide-react'
import { headerStageFlags, useHeaderStage, type ResponsiveChrome } from '../app/useResponsiveChrome'
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from '../lib/limits'
import { AppearancePopover, type AppearanceProps } from './AppearancePopover'
import { SettingsPopover, type SettingsProps } from './SettingsPopover'

/* The one document header: identity on the left, actions on the right. Owned
   by the design workstream (E). Every action is a prop from App; the header
   never reaches into state itself.

   On Windows this row is also the title bar (`data-titlebar='overlay'` on the
   root, set by App): styles.css makes its background the drag region, every
   control `no-drag`, stretches it across the outline and agent columns to the
   window's right edge and reserves the corner the native caption buttons
   overlay. Nothing here knows about that; the reserve is padding, so the
   stage measurement below already counts it.

   The integrations sit here too, in place of a menu strip: the agent-panel
   toggle (while the agent is on), an Ephy menu (while Ephy is on) and
   Settings, the gear, which is where either is turned on.

   When the row runs out of room it steps down through Mac's eight stages
   (ContentView.DocumentHeader + ChromeLayout.HeaderStage) and never clips:
   full → iconViews → noShortcutHint → iconSaveAs → noSubtitle → overflow →
   compact → iconSave. Three controls never move into the ⋯ menu at any stage:
   the library, outline and agent-panel toggles are the only ways back to a
   closed panel from the header. The agent toggle shows only while the agent
   is enabled (Mac), and Save reads "Save to Ephy" on an Ephy note (Mac).
   Ephy and Settings join Appearance and Focus in the ⋯ menu from `overflow`
   on, and in focus mode, where the row stays quiet. */

export type EphyCommand = 'ephyOpen' | 'ephySave' | 'ephySaveAsNew' | 'ephyOpenInBrowser' | 'ephyGetLatest'

export type HeaderProps = {
  title: string
  notice: string
  hasDocument: boolean
  view: ViewMode
  focusMode: boolean
  sidebarOpen: boolean
  outlineOpen: boolean
  /** Integrations ▸ Agent is on: the header carries the agent-panel toggle. */
  agentEnabled: boolean
  agentOpen: boolean
  /** Integrations ▸ Ephy is on: the header carries the Ephy menu. */
  ephyEnabled: boolean
  /** The active document is an Ephy note, so Save publishes to Ephy. */
  isEphyNote: boolean
  chrome: ResponsiveChrome
  appearance: AppearanceProps
  settings: SettingsProps
  onEphy: (command: EphyCommand) => void
  onToggleSidebar: () => void
  onToggleFocus: () => void
  onToggleOutline: () => void
  onToggleAgent: () => void
  onSetView: (view: ViewMode) => void
  onSave: () => void
  onSaveAs: () => void
}

const VIEWS: Array<{ mode: ViewMode; label: string; name: string; shortcut: string; icon: typeof BookOpen }> = [
  { mode: 'read', label: 'Read', name: 'Reading view', shortcut: 'Ctrl+1', icon: BookOpen },
  { mode: 'split', label: 'Split', name: 'Split view', shortcut: 'Ctrl+2', icon: SplitSquareHorizontal },
  { mode: 'write', label: 'Write', name: 'Writing view', shortcut: 'Ctrl+3', icon: PencilLine }
]

type MenuItem = {
  key: string
  label: string
  icon?: ReactNode
  hint?: string
  disabled?: boolean
  /** Present on a radio item; true marks the current choice. */
  checked?: boolean
  separated?: boolean
  onSelect: () => void
}

/* A small popup menu for the late header stages. Positioned against its own
   button and right-aligned, so it opens into the workspace at any width. */
function HeaderMenu({ label, title, className, trigger, items }: {
  label: string
  title: string
  className?: string
  trigger: ReactNode
  items: MenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    /* Capture, and stop there: Escape closes this menu and nothing else — it
       must not also fall through to leaving focus mode or closing the outline. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      button.current?.focus()
    }
    window.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', onKey, true)
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  /* The list hangs right-aligned from its button. Where the header keeps
     clear of the window controls the button sits further left, so in a narrow
     window the list would run off the left edge: nudge it back in. */
  useLayoutEffect(() => {
    const element = list.current
    if (!open || !element) return
    element.style.transform = ''
    const overhang = 8 - element.getBoundingClientRect().left
    if (overhang > 0) element.style.transform = `translateX(${Math.ceil(overhang)}px)`
  }, [open])

  const moveFocus = (step: number) => {
    const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!options.length) return
    const at = options.indexOf(document.activeElement as HTMLButtonElement)
    options[(at + step + options.length) % options.length].focus()
  }

  return (
    <div className={`header-menu ${className ?? ''}`} ref={root}>
      <button
        ref={button}
        className="icon-button header-menu-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open && (
        <div
          className="header-menu-list"
          id={id}
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1) }
            if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1) }
            if (event.key === 'Tab') setOpen(false)
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              className={[item.separated ? 'separated' : '', item.checked ? 'checked' : ''].filter(Boolean).join(' ') || undefined}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Header(props: HeaderProps) {
  const { title, notice, hasDocument, view, focusMode, sidebarOpen, outlineOpen, agentEnabled, agentOpen, ephyEnabled, isEphyNote, appearance, settings } = props
  const header = useRef<HTMLElement>(null)
  /* Focus mode changes which controls the row holds, and the selected view is
     drawn bolder than the others, so either resets the measurements. The
     title and notice are elastic and do not. */
  const stage = useHeaderStage(header, `${focusMode ? 'focus' : 'normal'}|${view}|${isEphyNote ? 'ephy' : 'file'}|${agentEnabled ? 'agent' : ''}|${ephyEnabled ? 'ephyMenu' : ''}`)
  const saveLabel = isEphyNote ? 'Save to Ephy' : 'Save'
  const flags = headerStageFlags(stage)
  const current = VIEWS.find((item) => item.mode === view) ?? VIEWS[0]
  const CurrentIcon = current.icon

  /* File ▸ Ephy, as the application menu has it. */
  const ephyItems: MenuItem[] = ephyEnabled ? [
    { key: 'ephyOpen', label: 'Open from Ephy…', hint: 'Ctrl+Shift+E', icon: <Cloud size={15} strokeWidth={1.7} />, onSelect: () => props.onEphy('ephyOpen') },
    { key: 'ephySave', label: 'Save to Ephy', disabled: !hasDocument, onSelect: () => props.onEphy('ephySave') },
    { key: 'ephySaveAsNew', label: 'Save as New Ephy Artifact…', disabled: !hasDocument, onSelect: () => props.onEphy('ephySaveAsNew') },
    { key: 'ephyOpenInBrowser', label: 'Open in Browser', separated: true, disabled: !isEphyNote, onSelect: () => props.onEphy('ephyOpenInBrowser') },
    { key: 'ephyGetLatest', label: 'Get Latest', disabled: !isEphyNote, onSelect: () => props.onEphy('ephyGetLatest') }
  ] : []
  /* Focus mode keeps the row quiet: no Ephy or Settings buttons. They stay
     reachable from the ⋯ menu whenever it is drawn, and from Alt / F10. */
  const tucked = flags.usesOverflow || focusMode

  const overflowItems: MenuItem[] = [
    ...(flags.isCompact
      ? [{ key: 'saveAs', label: 'Save as…', hint: 'Ctrl+Shift+S', icon: <SaveAll size={15} strokeWidth={1.7} />, disabled: !hasDocument, onSelect: props.onSaveAs }]
      : []),
    { key: 'appearance', label: 'Reading font…', icon: <Type size={15} strokeWidth={1.7} />, separated: flags.isCompact, onSelect: () => appearance.setOpen(true) },
    { key: 'zoomIn', label: 'Zoom in', hint: 'Ctrl+=', icon: <ZoomIn size={15} strokeWidth={1.7} />, disabled: appearance.zoomLevel >= MAX_ZOOM, onSelect: () => appearance.changeZoom(ZOOM_STEP) },
    { key: 'zoomOut', label: 'Zoom out', hint: 'Ctrl+-', icon: <ZoomOut size={15} strokeWidth={1.7} />, disabled: appearance.zoomLevel <= MIN_ZOOM, onSelect: () => appearance.changeZoom(-ZOOM_STEP) },
    { key: 'zoomReset', label: 'Actual size', hint: 'Ctrl+0', disabled: appearance.zoomLevel === DEFAULT_ZOOM, onSelect: () => appearance.changeZoom(DEFAULT_ZOOM - appearance.zoomLevel) },
    ...(focusMode
      ? []
      : [{ key: 'focus', label: 'Focus mode', hint: 'Ctrl+Shift+F', icon: <Maximize2 size={15} strokeWidth={1.7} />, separated: true, onSelect: props.onToggleFocus }]),
    ...ephyItems.map((item, index) => (index === 0 ? { ...item, separated: true } : item)),
    { key: 'settings', label: 'Settings…', icon: <Settings size={15} strokeWidth={1.7} />, separated: true, onSelect: () => settings.setOpen(true) }
  ]

  return (
    <header className="document-header" data-stage={stage} ref={header}>
      <div className="document-identity">
        {focusMode ? (
          <button className="icon-button" aria-label="Leave focus mode" title="Leave focus mode (Escape)" onClick={props.onToggleFocus}>
            <Minimize2 size={18} strokeWidth={1.7} />
          </button>
        ) : (
          <button className="icon-button" aria-label={sidebarOpen ? 'Hide library' : 'Show library'} aria-expanded={sidebarOpen} title={`${sidebarOpen ? 'Hide' : 'Show'} library (Ctrl+B)`} onClick={props.onToggleSidebar}>
            <PanelLeft size={18} strokeWidth={1.7} />
          </button>
        )}
        {!focusMode && !flags.isCompact && <span className="file-tab" aria-hidden="true"><FileText size={15} strokeWidth={1.8} /></span>}
        <div className="identity-text">
          <h1 title={title}>{title}</h1>
          {/* The live region stays mounted at every stage, so a notice is still
              announced after its line has stepped out of the header. */}
          {!focusMode && (
            <p role="status" aria-live="polite" className={flags.showsSubtitle ? undefined : 'visually-hidden'}><span>{notice}</span></p>
          )}
        </div>
      </div>
      <div className="document-tools">
        {flags.isCompact ? (
          <HeaderMenu
            className="view-menu"
            label={`Document view, ${current.label}`}
            title={`Document view: ${current.label} (Ctrl+1, Ctrl+2, Ctrl+3)`}
            trigger={<><CurrentIcon size={17} strokeWidth={1.7} /><ChevronDown size={12} strokeWidth={2} /></>}
            items={VIEWS.map((item) => ({
              key: item.mode,
              label: item.label,
              hint: item.shortcut,
              icon: <item.icon size={15} strokeWidth={1.7} />,
              checked: item.mode === view,
              onSelect: () => props.onSetView(item.mode)
            }))}
          />
        ) : (
          <div className="view-switcher" role="group" aria-label="Document view">
            {VIEWS.map((item) => (
              <button
                key={item.mode}
                className={view === item.mode ? 'selected' : ''}
                aria-pressed={view === item.mode}
                aria-label={item.name}
                title={`${item.label} (${item.shortcut})`}
                onClick={() => props.onSetView(item.mode)}
              >
                <item.icon size={16} /> {flags.viewLabels && <span>{item.label}</span>}
              </button>
            ))}
          </div>
        )}
        <AppearancePopover {...appearance} hideButton={flags.usesOverflow} />
        {!flags.isCompact && (flags.saveAsLabel ? (
          <button className="save-as-button" title="Save as (Ctrl+Shift+S)" disabled={!hasDocument} onClick={props.onSaveAs}>Save as</button>
        ) : (
          <button className="icon-button" aria-label="Save as" title="Save as (Ctrl+Shift+S)" disabled={!hasDocument} onClick={props.onSaveAs}>
            <SaveAll size={18} strokeWidth={1.7} />
          </button>
        ))}
        {flags.usesOverflow && (
          <HeaderMenu
            label="More"
            title="More: appearance, zoom, focus and settings"
            trigger={<Ellipsis size={18} strokeWidth={1.7} />}
            items={overflowItems}
          />
        )}
        <button className="save-button" aria-label={saveLabel} title={`${saveLabel} (Ctrl+S)`} disabled={!hasDocument} onClick={props.onSave}>
          <Check size={16} strokeWidth={2.2} />
          {flags.saveLabel && <span className="save-label">{saveLabel}</span>}
          {flags.showsShortcutHint && <kbd>Ctrl+S</kbd>}
        </button>
        {!focusMode && (
          <>
            {/* Never in the ⋯ menu: the only way back to a closed outline. */}
            <button className="icon-button outline-toggle" aria-label={outlineOpen ? 'Hide outline' : 'Show outline'} aria-expanded={outlineOpen} title={`${outlineOpen ? 'Hide' : 'Show'} outline (Ctrl+\\)`} onClick={props.onToggleOutline}>
              {outlineOpen ? <PanelRightClose size={18} strokeWidth={1.7} /> : <PanelRightOpen size={18} strokeWidth={1.7} />}
            </button>
            {/* Never in the ⋯ menu either: the way back to a closed agent panel. */}
            {agentEnabled && (
              <button
                className={`icon-button agent-toggle${agentOpen ? ' selected' : ''}`}
                aria-label={agentOpen ? 'Hide agent panel' : 'Show agent panel'}
                aria-pressed={agentOpen}
                title={`${agentOpen ? 'Hide' : 'Show'} agent panel (Ctrl+Alt+A)`}
                onClick={props.onToggleAgent}
              >
                <Bot size={18} strokeWidth={1.7} />
              </button>
            )}
            {ephyEnabled && !flags.usesOverflow && (
              <HeaderMenu
                className="ephy-menu"
                label="Ephy"
                title="Ephy: open, save and publish"
                trigger={<Cloud size={18} strokeWidth={1.7} />}
                items={ephyItems}
              />
            )}
            {!flags.usesOverflow && (
              <button className="icon-button" aria-label="Focus mode" title="Focus mode (Ctrl+Shift+F)" onClick={props.onToggleFocus}>
                <Maximize2 size={18} strokeWidth={1.7} />
              </button>
            )}
          </>
        )}
        {/* Last in the row, beside the window controls: the app, not the document. */}
        <SettingsPopover {...settings} hideButton={tucked} />
      </div>
    </header>
  )
}
