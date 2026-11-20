/* Bundled font faces, imported once by src/bootstrap.tsx. Owned by the
   design/fonts workstream (E). Manrope is chrome; Source Serif 4 is the
   default reading font. Every other reading font is either a system stack or
   an installed font found at runtime (installedFonts.ts) — never bundled. */
import '@fontsource-variable/manrope'
import './sourceSerif.css'
import { publishInstalledFonts } from './installedFonts'

publishInstalledFonts()
