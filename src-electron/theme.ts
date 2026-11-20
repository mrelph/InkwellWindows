import { nativeTheme } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAppTheme, isAppearanceMode, type AppTheme, type AppearanceMode } from './ipc/contract'

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark'

export type RgbColor = { r: number; g: number; b: number }

export type ThemeTokens = {
  mode: ThemeMode
  themeName: string
  '--surface-reader': string
  '--surface-panel': string
  '--surface-canvas': string
  '--surface-chrome': string
  '--surface-raised': string
  '--surface-code': string
  '--text-primary': string
  '--text-secondary': string
  '--text-muted': string
  '--text-inverse': string
  '--line-hairline': string
  '--line-strong': string
  '--accent': string
  '--accent-hover': string
  '--accent-contrast': string
  '--accent-tint': string
  '--accent-ring': string
  '--caret': string
  '--selection-bg': string
  '--selection-text': string
}

type ColorsTable = Record<string, string>

/* ------------------------------------------------------------------ */
/* Paths                                                                */
/* ------------------------------------------------------------------ */

const HOME_DIR = os.homedir()
const OMARCHY_STATE_DIR = path.join(HOME_DIR, '.local', 'state', 'omarchy')
const CURRENT_DIR = path.join(OMARCHY_STATE_DIR, 'current')
const THEME_DIR = path.join(CURRENT_DIR, 'theme')
const COLORS_PATH = path.join(THEME_DIR, 'colors.toml')
const THEME_NAME_PATH = path.join(CURRENT_DIR, 'theme.name')
const LIGHT_MODE_MARKER_PATH = path.join(THEME_DIR, 'light.mode')

/* ------------------------------------------------------------------ */
/* Color math — pure, exported, testable in isolation                  */
/* ------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const isValidHex = (value: string | undefined): value is string => {
  if (!value) return false
  const normalized = value.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{3}$/.test(normalized) || /^[0-9a-fA-F]{6}$/.test(normalized)
}

export const hexToRgb = (hex: string): RgbColor => {
  const stripped = hex.trim().replace(/^#/, '')
  const expanded = stripped.length === 3
    ? stripped.split('').map((char) => char + char).join('')
    : stripped
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) throw new Error(`Invalid hex color: ${hex}`)
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16)
  }
}

export const rgbToHex = ({ r, g, b }: RgbColor): string => {
  const toByte = (channel: number) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0')
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`
}

export const normalizeHex = (hex: string): string => rgbToHex(hexToRgb(hex))

/* WCAG relative luminance — sRGB channels are linearized, not averaged. */
export const relativeLuminance = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex)
  const linearize = (channel: number) => {
    const s = channel / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

export const contrastRatio = (hexA: string, hexB: string): number => {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/* ratio 0 -> hexA, ratio 1 -> hexB */
export const mixColors = (hexA: string, hexB: string, ratio: number): string => {
  const t = clamp(ratio, 0, 1)
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  return rgbToHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  })
}

const toRgbaString = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/* ------------------------------------------------------------------ */
/* colors.toml — hand-rolled flat-line reader, not a general TOML parser */
/* ------------------------------------------------------------------ */

export const parseColorsToml = (text: string): ColorsTable => {
  const table: ColorsTable = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    if (!key || !rawValue) continue
    const quote = rawValue[0]
    if (quote === '"' || quote === "'") {
      const closing = rawValue.indexOf(quote, 1)
      table[key] = closing === -1 ? rawValue.slice(1) : rawValue.slice(1, closing)
    } else {
      /* TOML: an unquoted value ends at a ` #` comment. The value itself may
         start with `#` (a hex color), so only whitespace + `#` starts one. */
      const value = rawValue.replace(/\s+#.*$/, '').trim()
      if (value) table[key] = value
    }
  }
  return table
}

/* ------------------------------------------------------------------ */
/* Small IO helpers — never throw                                      */
/* ------------------------------------------------------------------ */

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

const readThemeName = async (): Promise<string> => {
  try {
    const raw = await readFile(THEME_NAME_PATH, 'utf8')
    const trimmed = raw.trim()
    return trimmed || 'unknown'
  } catch {
    return 'unknown'
  }
}

/* ------------------------------------------------------------------ */
/* Mode cascade                                                        */
/* ------------------------------------------------------------------ */

const normalizeModeValue = (value: string | undefined): ThemeMode | undefined =>
  value === 'light' || value === 'dark' ? value : undefined

const detectMode = async (colors: ColorsTable): Promise<ThemeMode> => {
  const fromMode = normalizeModeValue(colors.mode)
  if (fromMode) return fromMode

  const fromLegacyType = normalizeModeValue(colors.theme_type)
  if (fromLegacyType) return fromLegacyType

  if (await pathExists(LIGHT_MODE_MARKER_PATH)) return 'light'

  if (isValidHex(colors.background)) {
    return relativeLuminance(normalizeHex(colors.background)) >= 0.5 ? 'light' : 'dark'
  }

  return 'dark'
}

/* ------------------------------------------------------------------ */
/* Surface derivation — rank by measured contrast, never by field name */
/* ------------------------------------------------------------------ */

const BACKGROUND_KEYS = ['background', 'dark_background', 'darker_background', 'lighter_background'] as const
const FOREGROUND_KEYS = ['foreground', 'bright_foreground', 'light_foreground', 'dark_foreground'] as const

/* Bounded synthesis: if the theme doesn't provide four distinct background
   steps, generate the missing ones by mixing the nearest known surface
   toward the foreground in small increments. Guarded so it can never loop
   forever even on a maximally degenerate input. */
const ensureFourSurfaces = (rawSteps: readonly string[], foreground: string): string[] => {
  const unique = Array.from(new Set(rawSteps))
  if (unique.length >= 4) return unique.slice(0, 4)

  const seed = unique[unique.length - 1] ?? foreground
  const result = [...unique]
  let ratio = 0.12
  let guard = 0
  while (result.length < 4 && guard < 50) {
    guard += 1
    const candidate = mixColors(seed, foreground, Math.min(ratio, 0.92))
    if (!result.includes(candidate)) result.push(candidate)
    ratio += 0.12
  }
  /* Absolute last resort in case of pathological collisions — still bounded. */
  while (result.length < 4) {
    result.push(result.length % 2 === 0 ? '#000000' : '#ffffff')
  }
  return result
}

const rankSurfacesByContrast = (steps: readonly string[], reference: string): [string, string, string, string] => {
  const sorted = [...steps].sort((a, b) => contrastRatio(reference, b) - contrastRatio(reference, a))
  return [sorted[0], sorted[1], sorted[2], sorted[3]]
}

const deriveSurfaceCode = (reader: string, panel: string): string => {
  const candidate = mixColors(reader, panel, 0.5)
  if (candidate.toLowerCase() !== reader.toLowerCase()) return candidate
  /* Degenerate case: reader and panel coincide. Nudge in the direction that
     keeps it distinguishable from the reading surface. */
  const nudgeTarget = relativeLuminance(reader) >= 0.5 ? '#000000' : '#ffffff'
  return mixColors(reader, nudgeTarget, 0.08)
}

/* ------------------------------------------------------------------ */
/* Contrast enforcement                                                 */
/* ------------------------------------------------------------------ */

const passesAll = (color: string, minRatio: number, surfaces: readonly string[]) =>
  surfaces.every((surface) => contrastRatio(color, surface) >= minRatio)

const bestOf = (candidates: readonly string[], surfaces: readonly string[]): string =>
  candidates.reduce((best, candidate) => {
    const bestMin = Math.min(...surfaces.map((surface) => contrastRatio(best, surface)))
    const candidateMin = Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)))
    return candidateMin > bestMin ? candidate : best
  })

/* Discrete fallback chain (e.g. text-primary: foreground -> bright_foreground
   -> light_foreground -> dark_foreground -> white/black). Picks the first
   candidate that clears the floor against every listed surface; if none do,
   picks whichever comes closest rather than shipping the first candidate blindly. */
const pickFirstPassingContrast = (candidates: readonly string[], minRatio: number, surfaces: readonly string[]): string => {
  const valid = candidates.filter(isValidHex).map(normalizeHex)
  if (valid.length === 0) return '#000000'
  const passing = valid.find((candidate) => passesAll(candidate, minRatio, surfaces))
  return passing ?? bestOf(valid, surfaces)
}

/* Continuous enforcement (e.g. muted -> blend toward text-primary). Bounded
   loop — never infinite — with a final "never ship unreadable text" fallback. */
const enforceContrastFloor = (start: string, target: string, minRatio: number, surfaces: readonly string[], maxSteps = 40): string => {
  if (passesAll(start, minRatio, surfaces)) return start
  let current = start
  for (let step = 1; step <= maxSteps; step += 1) {
    current = mixColors(start, target, step / maxSteps)
    if (passesAll(current, minRatio, surfaces)) return current
  }
  return bestOf([current, target, '#ffffff', '#000000'], surfaces)
}

const pickExtremeForegrounds = (family: readonly string[]): string[] => {
  if (family.length === 0) return []
  const withLuminance = family.map((hex) => ({ hex, luminance: relativeLuminance(hex) }))
  const lightest = withLuminance.reduce((a, b) => (b.luminance > a.luminance ? b : a))
  const darkest = withLuminance.reduce((a, b) => (b.luminance < a.luminance ? b : a))
  return lightest.hex === darkest.hex ? [lightest.hex] : [lightest.hex, darkest.hex]
}

/* ------------------------------------------------------------------ */
/* Token assembly                                                       */
/* ------------------------------------------------------------------ */

/* Shared by both the theme-derived path and the static fallback, so the two
   stay mathematically consistent. `surfaces` must already be in final rank
   order: [reader, panel, canvas, chrome]. */
const finalizeTokens = (
  mode: ThemeMode,
  themeName: string,
  surfaces: readonly [string, string, string, string],
  textPrimaryCandidates: readonly string[],
  mutedRaw: string | undefined,
  accentRaw: string | undefined,
  selectionRaw: string | undefined,
  foregroundFamilyForAccent: readonly string[]
): ThemeTokens => {
  const [surfaceReader, surfacePanel, surfaceCanvas, surfaceChrome] = surfaces

  const textPrimary = pickFirstPassingContrast(textPrimaryCandidates, 4.5, [surfaceReader])

  const mutedBase = isValidHex(mutedRaw) ? normalizeHex(mutedRaw) : mixColors(textPrimary, surfaceChrome, 0.35)
  const textMuted = enforceContrastFloor(mutedBase, textPrimary, 4.5, [surfacePanel, surfaceCanvas, surfaceChrome])

  const secondaryBase = mixColors(textPrimary, surfaceChrome, 0.24)
  const textSecondary = enforceContrastFloor(secondaryBase, textPrimary, 4.5, [surfacePanel, surfaceCanvas, surfaceChrome])

  const surfaceRaised = mixColors(surfacePanel, surfaceReader, 0.4)
  const surfaceCode = deriveSurfaceCode(surfaceReader, surfacePanel)
  const lineHairline = mixColors(surfacePanel, textPrimary, 0.16)
  const lineStrong = mixColors(surfacePanel, textPrimary, 0.5)

  const accent = isValidHex(accentRaw) ? normalizeHex(accentRaw) : (mode === 'dark' ? '#5fb08a' : '#1b6366')
  const accentHover = mixColors(accent, mode === 'dark' ? '#ffffff' : '#000000', 0.16)
  const accentExtremes = pickExtremeForegrounds(foregroundFamilyForAccent)
  const accentContrast = pickFirstPassingContrast([...accentExtremes, '#ffffff', '#000000'], 4.5, [accent])
  const accentTint = toRgbaString(accent, 0.16)
  const accentRing = mixColors(accent, '#ffffff', 0.18)

  const caret = accent
  const selectionBg = isValidHex(selectionRaw) ? normalizeHex(selectionRaw) : mixColors(accent, surfaceReader, 0.82)
  const selectionText = pickFirstPassingContrast([textPrimary, '#ffffff', '#000000'], 4.5, [selectionBg])

  /* --text-inverse and --accent-contrast serve the identical role ("text/icon
     on an accent fill") under the two different vocabulary sections; unified
     to one computed value rather than deriving it twice. */
  const textInverse = accentContrast

  return {
    mode,
    themeName,
    '--surface-reader': surfaceReader,
    '--surface-panel': surfacePanel,
    '--surface-canvas': surfaceCanvas,
    '--surface-chrome': surfaceChrome,
    '--surface-raised': surfaceRaised,
    '--surface-code': surfaceCode,
    '--text-primary': textPrimary,
    '--text-secondary': textSecondary,
    '--text-muted': textMuted,
    '--text-inverse': textInverse,
    '--line-hairline': lineHairline,
    '--line-strong': lineStrong,
    '--accent': accent,
    '--accent-hover': accentHover,
    '--accent-contrast': accentContrast,
    '--accent-tint': accentTint,
    '--accent-ring': accentRing,
    '--caret': caret,
    '--selection-bg': selectionBg,
    '--selection-text': selectionText
  }
}

/* The app themes (Mac AppTheme.swift, copied exactly). Each has a light and a
   dark spec; every one goes through finalizeTokens like any other palette.
   Fonts are not part of a theme. */
type ThemeSpec = { reader: string; panel: string; canvas: string; chrome: string; text: string; muted: string; accent: string }

export const APP_THEME_SPECS: Record<AppTheme, Record<ThemeMode, ThemeSpec>> = {
  inkwell: {
    light: { reader: '#fbf8f1', panel: '#e9e2d6', canvas: '#e8e1d5', chrome: '#f7f3ec', text: '#1c2b31', muted: '#6b6459', accent: '#1b6366' },
    dark: { reader: '#171b1d', panel: '#202629', canvas: '#272e31', chrome: '#111517', text: '#f4eee3', muted: '#b9b0a4', accent: '#67b5b3' }
  },
  paper: {
    light: { reader: '#f6efdf', panel: '#e6d9bf', canvas: '#e4d6bb', chrome: '#f1e7d2', text: '#3b2f22', muted: '#6a5843', accent: '#8a4b1f' },
    dark: { reader: '#1e1a15', panel: '#29231c', canvas: '#312a21', chrome: '#16130f', text: '#eadcc4', muted: '#bba98c', accent: '#d39a5c' }
  },
  slate: {
    light: { reader: '#f7f9fb', panel: '#e2e8ef', canvas: '#dfe5ec', chrome: '#f0f3f7', text: '#1e2a38', muted: '#536073', accent: '#2f5f8f' },
    dark: { reader: '#161b22', panel: '#1e252e', canvas: '#252d37', chrome: '#10141a', text: '#e4eaf1', muted: '#a6b1bf', accent: '#7aa7d6' }
  },
  forest: {
    light: { reader: '#f6f8f3', panel: '#dfe7da', canvas: '#dce4d6', chrome: '#eff3eb', text: '#1d2b22', muted: '#516253', accent: '#2e6b45' },
    dark: { reader: '#121a15', panel: '#19241d', canvas: '#1f2c24', chrome: '#0d130f', text: '#e3ece4', muted: '#a3b5a7', accent: '#6fbf8a' }
  },
  midnight: {
    light: { reader: '#ffffff', panel: '#eceef4', canvas: '#e6e9f1', chrome: '#f6f7fb', text: '#0a0e1a', muted: '#3d4458', accent: '#3b3fb5' },
    dark: { reader: '#05070d', panel: '#0c1020', canvas: '#11162a', chrome: '#000000', text: '#ffffff', muted: '#c4cae0', accent: '#8e9bff' }
  }
}

/** Tokens for an app theme in a given mode (Mac `AppTheme.tokens(_:)`). */
export const appThemeTokens = (appTheme: AppTheme, mode: ThemeMode): ThemeTokens => {
  const spec = APP_THEME_SPECS[appTheme][mode]
  return finalizeTokens(
    mode,
    appTheme === 'inkwell' ? `system-${mode}` : `${appTheme}-${mode}`,
    [spec.reader, spec.panel, spec.canvas, spec.chrome],
    [spec.text, '#ffffff', '#000000'],
    spec.muted,
    spec.accent,
    undefined,
    [spec.text]
  )
}

/* The user's choice (View ▸ Appearance). Main owns the live value: it is set
   from library.json before the window exists, then by `theme:set-appearance`. */
let currentAppearance: AppearanceMode = 'system'
let currentAppTheme: AppTheme = 'inkwell'

export const getAppearance = (): { appearance: AppearanceMode; theme: AppTheme } =>
  ({ appearance: currentAppearance, theme: currentAppTheme })

/** Validates, stores and forces the native theme so menus and dialogs match.
    Returns false (and changes nothing) for a value outside the enums. */
export function setAppearance(appearance: unknown, appTheme: unknown): boolean {
  if (!isAppearanceMode(appearance) || !isAppTheme(appTheme)) return false
  currentAppearance = appearance
  currentAppTheme = appTheme
  try {
    nativeTheme.themeSource = appearance
  } catch {
    /* Not fatal: tokens below are computed from the choice, not read back. */
  }
  return true
}

const effectiveMode = (): ThemeMode =>
  currentAppearance === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : currentAppearance

/* Non-Omarchy fallback. It follows the chosen mode (System = the host) and
   theme, through the same contrast pipeline. Inkwell is the default palette. */
const buildFallbackTokens = (mode: ThemeMode = effectiveMode()): ThemeTokens =>
  appThemeTokens(currentAppTheme, mode)

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function resolveTheme(): Promise<ThemeTokens> {
  try {
    if (!(await pathExists(OMARCHY_STATE_DIR))) return buildFallbackTokens()

    const [colorsRaw, themeName] = await Promise.all([
      readFile(COLORS_PATH, 'utf8'),
      readThemeName()
    ])
    const colors = parseColorsToml(colorsRaw)
    const mode = await detectMode(colors)

    const foregroundFamily = FOREGROUND_KEYS.map((key) => colors[key]).filter(isValidHex).map(normalizeHex)
    const sortReference = foregroundFamily[0] ?? (mode === 'dark' ? '#ffffff' : '#000000')

    const rawBackgroundSteps = BACKGROUND_KEYS.map((key) => colors[key]).filter(isValidHex).map(normalizeHex)
    const backgroundSteps = ensureFourSurfaces(rawBackgroundSteps, sortReference)
    const rankedSurfaces = rankSurfacesByContrast(backgroundSteps, sortReference)

    const tail = mode === 'dark' ? ['#ffffff', '#000000'] : ['#000000', '#ffffff']
    const textPrimaryCandidates = FOREGROUND_KEYS
      .map((key) => colors[key])
      .filter(isValidHex)
      .map(normalizeHex)
      .concat(tail)

    return finalizeTokens(
      mode,
      themeName,
      rankedSurfaces,
      textPrimaryCandidates,
      colors.muted,
      colors.accent,
      colors.selection,
      foregroundFamily
    )
  } catch (error) {
    console.warn('[inkwell/theme] falling back to default palette:', error instanceof Error ? error.message : error)
    return buildFallbackTokens()
  }
}

export function watchTheme(onChange: (tokens: ThemeTokens) => void): () => void {
  let watcher: ReturnType<typeof watch> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleReresolve = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      resolveTheme().then(onChange).catch(() => {})
    }, 120)
  }

  nativeTheme.on('updated', scheduleReresolve)

  try {
    watcher = watch(CURRENT_DIR, { persistent: false }, scheduleReresolve)
    watcher.on('error', () => {})
  } catch {
    /* Non-Omarchy systems have no directory to watch; nativeTheme still does. */
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    watcher?.close()
    nativeTheme.removeListener('updated', scheduleReresolve)
  }
}
