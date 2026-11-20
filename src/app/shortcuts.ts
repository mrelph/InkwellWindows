/* The ONE keyboard dispatcher's table (PARITY §10, Windows key map). The
   renderer handles every shortcut; the application menu only *displays* these
   accelerators (pushed in MenuState.accelerators) with registerAccelerator:
   false, so nothing fires twice. DOM-free apart from the event shape, so the
   table can be unit-tested. */

/** `true`/`false` must match exactly; `'any'` ignores the modifier — except
    that a Ctrl binding never matches while Alt is also down unless it asks
    for Alt (`alt: true`): on Windows AltGr arrives as Ctrl+Alt, and AltGr+key
    is how German, French and Spanish layouts type `\`, `@`, `{`… (see
    matchShortcut). */
type Modifier = boolean | 'any'

export type Shortcut = {
  id: CommandId
  /** `KeyboardEvent.key`, lower-cased ('s', 'f3', 'delete', 'escape', '\\'). */
  key: string
  /** Ctrl (or Meta). */
  ctrl: Modifier
  shift: Modifier
  alt: Modifier
  /** Electron accelerator for the menu's display. Omitted on alternates. */
  accelerator?: string
  arg?: string
  /** Skip while typing in a text field, where the key already means something
      (Ctrl+Delete deletes the next word). */
  notInText?: boolean
  /** Default true: preventDefault on match. */
  claim?: boolean
}

export const SHORTCUTS: Shortcut[] = [
  // File
  { id: 'newNote', key: 'n', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+N' },
  { id: 'open', key: 'o', ctrl: true, shift: false, alt: 'any', accelerator: 'CmdOrCtrl+O' },
  { id: 'addFolder', key: 'o', ctrl: true, shift: true, alt: 'any', accelerator: 'CmdOrCtrl+Shift+O' },
  { id: 'save', key: 's', ctrl: true, shift: false, alt: 'any', accelerator: 'CmdOrCtrl+S' },
  { id: 'saveAs', key: 's', ctrl: true, shift: true, alt: 'any', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'closeDocument', key: 'w', ctrl: true, shift: false, alt: false, accelerator: 'CmdOrCtrl+W' },
  { id: 'duplicate', key: 'd', ctrl: true, shift: true, alt: false, accelerator: 'CmdOrCtrl+Shift+D' },
  { id: 'reveal', key: 'r', ctrl: true, shift: true, alt: false, accelerator: 'CmdOrCtrl+Shift+R' },
  { id: 'copyPath', key: 'c', ctrl: true, shift: false, alt: true, accelerator: 'CmdOrCtrl+Alt+C' },
  { id: 'trash', key: 'delete', ctrl: true, shift: false, alt: false, accelerator: 'CmdOrCtrl+Delete', notInText: true },
  // Find
  { id: 'find', key: 'f', ctrl: true, shift: false, alt: false, accelerator: 'CmdOrCtrl+F' },
  { id: 'replace', key: 'h', ctrl: true, shift: false, alt: false, accelerator: 'CmdOrCtrl+H' },
  { id: 'findNext', key: 'f3', ctrl: false, shift: false, alt: false, accelerator: 'F3' },
  { id: 'findPrevious', key: 'f3', ctrl: false, shift: true, alt: false, accelerator: 'Shift+F3' },
  { id: 'useSelectionForFind', key: 'e', ctrl: true, shift: false, alt: false, accelerator: 'CmdOrCtrl+E' },
  { id: 'findInDocuments', key: 'l', ctrl: true, shift: true, alt: false, accelerator: 'CmdOrCtrl+Shift+L' },
  // View
  { id: 'viewRead', key: '1', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+1' },
  { id: 'viewSplit', key: '2', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+2' },
  { id: 'viewWrite', key: '3', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+3' },
  { id: 'toggleLibrary', key: 'b', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+B' },
  { id: 'toggleOutline', key: '\\', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+\\' },
  { id: 'focus', key: 'f', ctrl: true, shift: true, alt: 'any', accelerator: 'CmdOrCtrl+Shift+F' },
  { id: 'zoomIn', key: '=', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+=' },
  { id: 'zoomIn', key: '+', ctrl: true, shift: 'any', alt: 'any' },
  { id: 'zoomOut', key: '-', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+-' },
  { id: 'zoomReset', key: '0', ctrl: true, shift: 'any', alt: 'any', accelerator: 'CmdOrCtrl+0' },
  { id: 'toggleFullScreen', key: 'f11', ctrl: false, shift: false, alt: false, accelerator: 'F11' },
  // Integrations
  { id: 'toggleAgentPanel', key: 'a', ctrl: true, shift: false, alt: true, accelerator: 'CmdOrCtrl+Alt+A' },
  { id: 'ephyOpen', key: 'e', ctrl: true, shift: true, alt: false, accelerator: 'CmdOrCtrl+Shift+E' },
  /* Escape is never claimed: fields and the row menu see it first and stop it
     from reaching here when it is theirs. */
  { id: 'escape', key: 'escape', ctrl: 'any', shift: 'any', alt: 'any', claim: false }
]

export type KeyLike = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  /** `event.getModifierState('AltGraph')`: Chromium sets it on Windows when
      the right Alt key is AltGr on the current layout. */
  altGraph?: boolean
}

const matches = (wanted: Modifier, actual: boolean) => wanted === 'any' || wanted === actual

/** The shortcut for this key event, or null. `inTextField` is true when focus
    is in a textarea, input, select or contenteditable.

    AltGr: Windows reports AltGr as Ctrl+Alt (plus AltGraph). So
    - a Ctrl binding that does not ask for Alt never matches with Alt down —
      AltGr+\ types a backslash on a German keyboard, it does not toggle the
      outline;
    - a Ctrl+Alt binding (Copy Path, Agent panel) ignores an AltGr press, so
      on a layout where AltGr+C or AltGr+A types a character, that character
      is typed. A real Ctrl+Alt (left keys) still reaches them. */
export function matchShortcut(event: KeyLike, inTextField: boolean, table: Shortcut[] = SHORTCUTS): Shortcut | null {
  const key = event.key.toLowerCase()
  const ctrl = event.ctrlKey || event.metaKey
  for (const shortcut of table) {
    if (shortcut.key !== key) continue
    if (!matches(shortcut.ctrl, ctrl) || !matches(shortcut.shift, event.shiftKey) || !matches(shortcut.alt, event.altKey)) continue
    if (shortcut.ctrl === true && event.altKey && shortcut.alt !== true) continue
    if (shortcut.ctrl === true && event.altGraph === true) continue
    if (shortcut.notInText && inTextField) continue
    return shortcut
  }
  return null
}

/** The KeyLike of a DOM keyboard event, AltGr included. */
export const keyLikeOf = (event: KeyboardEvent): KeyLike => ({
  key: event.key,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  altGraph: typeof event.getModifierState === 'function' ? event.getModifierState('AltGraph') : false
})

/** Command id → accelerator, for MenuState.accelerators. First entry wins. */
export function acceleratorMap(table: Shortcut[] = SHORTCUTS): Partial<Record<CommandId, string>> {
  const map: Partial<Record<CommandId, string>> = {}
  for (const shortcut of table) {
    if (shortcut.accelerator && !map[shortcut.id]) map[shortcut.id] = shortcut.accelerator
  }
  return map
}

export const isTextField = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  const tag = element.tagName.toLowerCase()
  return tag === 'textarea' || tag === 'input' || tag === 'select' || element.isContentEditable === true
}
