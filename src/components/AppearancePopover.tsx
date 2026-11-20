import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, Type } from 'lucide-react'
import { publishInstalledFonts } from '../fonts/installedFonts'
import { DEFAULT_READER_FONT, READER_FONTS, readerFontLabel } from '../fonts/readerFonts'
import { APPEARANCE_LABELS, APPEARANCE_VALUES, APP_THEME_LABELS, APP_THEME_VALUES } from '../../src-electron/ipc/contract'
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from '../lib/limits'

/* Reading font and display zoom (Mac ContentView.AppearancePanel). Owned by
   the design/fonts workstream (E). App owns `open` (Escape closes it first)
   and the values. */

export type AppearanceProps = {
  open: boolean
  setOpen: (open: boolean | ((current: boolean) => boolean)) => void
  appearance: AppearanceMode
  setAppearance: (mode: AppearanceMode) => void
  theme: AppTheme
  setTheme: (theme: AppTheme) => void
  readerFont: ReaderFont
  setReaderFont: (font: ReaderFont) => void
  zoomLevel: number
  changeZoom: (amount: number) => void
  reset: () => void
}

type Props = AppearanceProps & {
  /** Late header stages move Appearance into the ⋯ menu. The panel itself
      stays mounted here so the menu can still open it. */
  hideButton?: boolean
}

export function AppearancePopover({ open, setOpen, appearance, setAppearance, theme, setTheme, readerFont, setReaderFont, zoomLevel, changeZoom, reset, hideButton }: Props) {
  const control = useRef<HTMLDivElement>(null)
  const [installed, setInstalled] = useState(publishInstalledFonts)

  useEffect(() => {
    if (!open) return
    /* Re-detect on every open, so a font installed while Inkwell runs shows
       up without a restart. */
    setInstalled(publishInstalledFonts())
    const closeOutside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside)
    return () => window.removeEventListener('pointerdown', closeOutside)
  }, [open, setOpen])

  return (
    <div className={`appearance-control ${hideButton ? 'appearance-buttonless' : ''}`} ref={control}>
      {!hideButton && (
        <button
          className="icon-button"
          aria-label="Appearance, theme, reading font and zoom"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Appearance, theme, reading font and zoom"
          onClick={() => setOpen((current) => !current)}
        >
          <Type size={18} strokeWidth={1.7} />
        </button>
      )}
      {open && (
        <div className="appearance-panel" role="dialog" aria-label="Appearance">
          <p className="appearance-heading"><Type size={15} strokeWidth={1.8} /> Appearance</p>
          <div className="appearance-field" role="group" aria-label="Mode">
            Mode
            <div className="segmented" role="radiogroup" aria-label="Mode">
              {APPEARANCE_VALUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={appearance === value}
                  className={appearance === value ? 'active' : ''}
                  onClick={() => setAppearance(value)}
                >
                  {APPEARANCE_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <label className="appearance-field" htmlFor="app-theme">
            Theme
            <select id="app-theme" value={theme} onChange={(event) => setTheme(event.target.value as AppTheme)}>
              {APP_THEME_VALUES.map((value) => <option key={value} value={value}>{APP_THEME_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="appearance-field" htmlFor="reader-font">
            Reading font
            <select
              id="reader-font"
              value={readerFont}
              onChange={(event) => setReaderFont(event.target.value as ReaderFont)}
            >
              {READER_FONTS.flatMap((font) => {
                const available = installed.has(font.value)
                /* A missing font stays in the list, greyed and marked. If it is
                   the saved choice it is still shown as selected: the choice is
                   kept and the reader draws the default until the font exists. */
                const option = <option key={font.value} value={font.value} disabled={!available}>{readerFontLabel(font, available)}</option>
                return font.startsBuiltInGroup ? [<hr key={`${font.value}-rule`} />, option] : [option]
              })}
            </select>
          </label>
          <div className="zoom-setting">
            <span>Display zoom</span>
            <div className="zoom-stepper" role="group" aria-label="Display zoom">
              <button type="button" aria-label="Zoom out" title="Zoom out (Ctrl+-)" disabled={zoomLevel <= MIN_ZOOM} onClick={() => changeZoom(-ZOOM_STEP)}><Minus size={14} /></button>
              <output aria-live="polite">{zoomLevel}%</output>
              <button type="button" aria-label="Zoom in" title="Zoom in (Ctrl++)" disabled={zoomLevel >= MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)}><Plus size={14} /></button>
            </div>
          </div>
          <button
            type="button"
            className="appearance-reset"
            disabled={appearance === 'system' && theme === 'inkwell' && readerFont === DEFAULT_READER_FONT && zoomLevel === DEFAULT_ZOOM}
            onClick={reset}
          >
            Reset appearance
          </button>
        </div>
      )}
    </div>
  )
}
