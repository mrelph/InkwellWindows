import { app, Menu, session, type BrowserWindow, type ContextMenuParams } from 'electron'
import { handle } from './ipcGuard'
import { getSetting, setSetting } from './settings'

/* The native context menu: spelling suggestions, Add to Dictionary,
   Cut/Copy/Paste/Select All, and a "Check Spelling While Typing" toggle
   (PARITY §3). Owned by the editor workstream (B). */

const MAX_SUGGESTIONS = 5

/** "Check Spelling While Typing". On by default. */
export function isSpellcheckEnabled(): boolean {
  return getSetting('spellcheck')
}

export function setSpellcheckEnabled(on: boolean): boolean {
  const next = setSetting('spellcheck', on === true)
  session.defaultSession.setSpellCheckerEnabled(next)
  return next
}

/** Spellcheck languages from the OS: the user's preferred languages (then the
    app locale) that the spellchecker has a dictionary for, else en-US. */
function applySpellcheckLanguages(): void {
  try {
    const available = new Set(session.defaultSession.availableSpellCheckerLanguages)
    const wanted = [...app.getPreferredSystemLanguages(), app.getLocale()]
    const chosen: string[] = []
    for (const tag of wanted) {
      const base = tag.split('-')[0].toLowerCase()
      const match = available.has(tag) ? tag : [...available].find((code) => code.split('-')[0].toLowerCase() === base)
      if (match && !chosen.includes(match)) chosen.push(match)
    }
    if (!chosen.length && available.has('en-US')) chosen.push('en-US')
    if (chosen.length) session.defaultSession.setSpellCheckerLanguages(chosen)
  } catch (error) {
    console.warn('Could not set spellcheck languages', error)
  }
}

function buildMenu(window: BrowserWindow, params: ContextMenuParams): Menu | null {
  const contents = window.webContents
  const hasSelection = params.selectionText.length > 0
  if (!params.isEditable && !hasSelection) return null

  const items: Electron.MenuItemConstructorOptions[] = []
  if (params.isEditable) {
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
      for (const suggestion of suggestions) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      }
      if (!suggestions.length) items.push({ label: 'No Spelling Suggestions', enabled: false })
      items.push({
        label: 'Add to Dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      items.push({ type: 'separator' })
    }
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Check Spelling While Typing',
        type: 'checkbox',
        checked: isSpellcheckEnabled(),
        click: (item) => { setSpellcheckEnabled(item.checked) }
      }
    )
  } else {
    items.push({ role: 'copy' }, { role: 'selectAll' })
  }
  return Menu.buildFromTemplate(items)
}

let registered = false

/** Registers once per process; call for each window to attach its menu. */
export function registerContextMenu(window: BrowserWindow): void {
  session.defaultSession.setSpellCheckerEnabled(isSpellcheckEnabled())
  window.webContents.on('context-menu', (_event, params) => {
    buildMenu(window, params)?.popup({ window })
  })
  if (registered) return
  registered = true
  applySpellcheckLanguages()
  handle('spellcheck:get', () => isSpellcheckEnabled())
  handle('spellcheck:set', (_event, value: unknown) => setSpellcheckEnabled(value === true))
}
