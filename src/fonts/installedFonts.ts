import { READER_FONTS, type ReaderFontOption } from './readerFonts'

/* Which of the installed-only reading fonts this machine has (Mac
   InkwellCore/InstalledFonts.swift). A missing family is reported, never
   fatal: the reader draws the default and the saved choice is kept, so it
   works again once the font is installed.

   Two signals, because neither is enough alone. `document.fonts.check()` is
   the cheap one, but for a family with no @font-face rule Chromium has
   answered both "true" and "false" for a font that is not there, depending on
   version. So a probe string is measured as well — drawn in the family with a
   generic fallback, then in the fallback alone; a different width means the
   family really drew. The measurement decides whenever a canvas is available,
   and `check()` decides only when it is not. */

const PROBE = 'mmmmmmmmmmlli WQ@#0123456789 The quick brown fox'
const GENERICS = ['monospace', 'serif', 'sans-serif']

const quote = (family: string) => `"${family.replace(/["\\]/g, '')}"`

function measured(family: string): boolean | null {
  try {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return null
    return GENERICS.some((generic) => {
      context.font = `72px ${generic}`
      const fallback = context.measureText(PROBE).width
      context.font = `72px ${quote(family)}, ${generic}`
      return context.measureText(PROBE).width !== fallback
    })
  } catch {
    return null
  }
}

function claimed(family: string): boolean {
  try {
    return document.fonts.check(`16px ${quote(family)}`)
  } catch {
    return false
  }
}

export function isFamilyInstalled(family: string): boolean {
  if (typeof document === 'undefined') return false
  return measured(family) ?? claimed(family)
}

/** Bundled and system fonts are always available; an installed-only font
    needs both its heading and its body family (Mac `ReaderFont.isInstalled`). */
export const isReaderFontInstalled = (font: ReaderFontOption): boolean =>
  !font.families || (isFamilyInstalled(font.families.heading) && isFamilyInstalled(font.families.body))

/** The values of every reading font that can be drawn right now. */
export function installedReaderFonts(): Set<string> {
  return new Set(READER_FONTS.filter(isReaderFontInstalled).map((font) => font.value as string))
}

/** Detects, and publishes the result as `data-fonts-installed` on the root so
    styles.css applies an installed-only font's family (and Ember's looser
    heading tracking) only where the font exists. Called at boot and whenever
    Appearance opens, so a font installed while Inkwell runs is picked up
    without a restart. */
export function publishInstalledFonts(): Set<string> {
  const found = installedReaderFonts()
  if (typeof document !== 'undefined') {
    const installedOnly = READER_FONTS.filter((font) => font.families && found.has(font.value as string))
    document.documentElement.dataset.fontsInstalled = installedOnly.map((font) => font.value).join(' ')
  }
  return found
}
