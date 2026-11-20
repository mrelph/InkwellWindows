/* The reading fonts offered in Appearance: Mac's ten, in Mac's order and with
   Mac's labels (InkwellCore/LibraryState.swift, `ReaderFont`). Owned by the
   design/fonts workstream (E). The `value`s are what library.json stores and
   what `:root[data-reader-font=…]` in styles.css keys on, and they are Mac's
   raw values so one library.json reads the same on both platforms. */

/** Reading fonts that are never bundled: they are used when the machine has
    them and shown greyed "(not installed)" when it does not. */
export type InstalledReaderFont = Extract<ReaderFont, 'bookerly' | 'ember' | 'roboto' | 'ubuntu' | 'geist-mono'>

export type ReaderFontOption = {
  value: ReaderFont
  label: string
  /** Installed families this choice needs (h1/h2 family, body family). Absent
      for fonts that ship with the app or with the system. */
  families?: { heading: string; body: string }
  /** The picker draws a separator before this option (Mac `startsBuiltInGroup`). */
  startsBuiltInGroup?: boolean
}

export const DEFAULT_READER_FONT: ReaderFont = 'editorial'

export const READER_FONTS: ReaderFontOption[] = [
  { value: 'editorial', label: 'Default (Source Serif 4)' },
  { value: 'bookerly', label: 'Bookerly', families: { heading: 'Bookerly', body: 'Bookerly' } },
  { value: 'ember', label: 'Ember Modern', families: { heading: 'Ember Modern Display', body: 'Ember Modern Text' } },
  { value: 'roboto', label: 'Roboto', families: { heading: 'Roboto', body: 'Roboto' } },
  { value: 'ubuntu', label: 'Ubuntu', families: { heading: 'Ubuntu', body: 'Ubuntu' } },
  { value: 'geist-mono', label: 'Geist Mono', families: { heading: 'Geist Mono', body: 'Geist Mono' } },
  { value: 'classic', label: 'Classic serif', startsBuiltInGroup: true },
  { value: 'sans', label: 'Rounded sans' },
  { value: 'system', label: 'System sans' },
  { value: 'mono', label: 'Monospace' }
]

/** The label for menus and pickers, marked when the font is missing. */
export const readerFontLabel = (font: ReaderFontOption, isInstalled: boolean) =>
  isInstalled ? font.label : `${font.label} (not installed)`
