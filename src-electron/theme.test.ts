import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeTheme = { shouldUseDarkColors: true, on: () => {}, removeListener: () => {} }
vi.mock('electron', () => ({ nativeTheme, app: { getPath: () => os.tmpdir() } }))

type ThemeModule = typeof import('./theme')
let theme: ThemeModule
let home = ''
const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }

/* HOME_DIR is read when theme.ts loads, so point the home at a temp dir first. */
const loadTheme = async (withOmarchy: boolean) => {
  vi.resetModules()
  home = await mkdtemp(path.join(os.tmpdir(), 'inkwell-theme-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  if (withOmarchy) await mkdir(path.join(home, '.local', 'state', 'omarchy', 'current', 'theme'), { recursive: true })
  theme = await import('./theme')
}
const writeColors = async (toml: string, name = 'test-theme') => {
  const current = path.join(home, '.local', 'state', 'omarchy', 'current')
  await writeFile(path.join(current, 'theme', 'colors.toml'), toml)
  await writeFile(path.join(current, 'theme.name'), `${name}\n`)
}

afterEach(async () => {
  process.env.USERPROFILE = saved.USERPROFILE
  process.env.HOME = saved.HOME
  if (home) await rm(home, { recursive: true, force: true })
  home = ''
})

describe('color math', () => {
  beforeEach(async () => { await loadTheme(false) })

  it('hex parsing and formatting', () => {
    expect(theme.hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(theme.hexToRgb('1c2b31')).toEqual({ r: 28, g: 43, b: 49 })
    expect(theme.rgbToHex({ r: 300, g: -4, b: 15.6 })).toBe('#ff0010')
    expect(theme.normalizeHex('#ABC')).toBe('#aabbcc')
    expect(() => theme.hexToRgb('#12')).toThrow()
    expect(() => theme.hexToRgb('zzzzzz')).toThrow()
  })

  it('isValidHex', () => {
    for (const v of ['#fff', 'FFF', '#a1b2c3', ' #a1b2c3 ']) expect(theme.isValidHex(v)).toBe(true)
    for (const v of [undefined, '', '#ffff', '#12345', 'rgb(0,0,0)', '#ggg', 'red']) expect(theme.isValidHex(v)).toBe(false)
  })

  it('relative luminance reference values', () => {
    expect(theme.relativeLuminance('#000000')).toBe(0)
    expect(theme.relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
    expect(theme.relativeLuminance('#ff0000')).toBeCloseTo(0.2126, 4)
    expect(theme.relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 4)
    expect(theme.relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 4)
    expect(theme.relativeLuminance('#808080')).toBeCloseTo(0.2159, 3)
  })

  it('WCAG contrast reference pairs', () => {
    expect(theme.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(theme.contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 10)
    expect(theme.contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(theme.contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(theme.contrastRatio('#0000ff', '#ffffff')).toBeCloseTo(8.59, 2)
  })

  it('contrast is symmetric', () => {
    expect(theme.contrastRatio('#123456', '#fedcba')).toBeCloseTo(theme.contrastRatio('#fedcba', '#123456'), 10)
  })

  it('mixColors interpolates and clamps', () => {
    expect(theme.mixColors('#000000', '#ffffff', 0)).toBe('#000000')
    expect(theme.mixColors('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(theme.mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(theme.mixColors('#000000', '#ffffff', 5)).toBe('#ffffff')
    expect(theme.mixColors('#000000', '#ffffff', -5)).toBe('#000000')
  })
})

describe('parseColorsToml', () => {
  beforeEach(async () => { await loadTheme(false) })

  it('reads a representative Omarchy colors.toml', () => {
    const table = theme.parseColorsToml([
      '# Rose Pine Dawn',
      'accent = "#56949f"',
      "foreground = '#575279'",
      'background = "#faf4ed"',
      '',
      '[palette]',
      '; comment',
      'color0 = "#f2e9e1"   ',
      'bare = #123456',
      'mode = "light"'
    ].join('\r\n'))
    expect(table).toMatchObject({
      accent: '#56949f', foreground: '#575279', background: '#faf4ed', color0: '#f2e9e1', bare: '#123456', mode: 'light'
    })
    expect(Object.keys(table)).not.toContain('palette')
  })

  it('skips malformed lines and tolerates unterminated quotes', () => {
    const table = theme.parseColorsToml('novalue\n= "#fff"\nkey =\nopen = "#abc\nok = "#def"')
    expect(table).toEqual({ open: '#abc', ok: '#def' })
  })

  it('empty input yields an empty table', () => {
    expect(theme.parseColorsToml('')).toEqual({})
  })

  // Fixed: trailing `# comments` on unquoted values are stripped.
  it('strips inline comments on unquoted values', () => {
    expect(theme.parseColorsToml('accent = #ffffff # note').accent).toBe('#ffffff')
    expect(theme.parseColorsToml('accent = #ffffff\t# note').accent).toBe('#ffffff')
    expect(theme.parseColorsToml('accent = "#ffffff" # note').accent).toBe('#ffffff')
  })
})

const FLOORS = (t: Awaited<ReturnType<ThemeModule['resolveTheme']>>, theme: ThemeModule) => ({
  textPrimaryVsReader: theme.contrastRatio(t['--text-primary'], t['--surface-reader']),
  accentContrast: theme.contrastRatio(t['--accent-contrast'], t['--accent']),
  selection: theme.contrastRatio(t['--selection-text'], t['--selection-bg']),
  mutedPanel: theme.contrastRatio(t['--text-muted'], t['--surface-panel']),
  mutedChrome: theme.contrastRatio(t['--text-muted'], t['--surface-chrome']),
  mutedCanvas: theme.contrastRatio(t['--text-muted'], t['--surface-canvas']),
  secondaryCanvas: theme.contrastRatio(t['--text-secondary'], t['--surface-canvas']),
  secondaryPanel: theme.contrastRatio(t['--text-secondary'], t['--surface-panel']),
  secondaryChrome: theme.contrastRatio(t['--text-secondary'], t['--surface-chrome'])
})

describe('system fallback tokens (no Omarchy)', () => {
  for (const dark of [true, false]) {
    it(`${dark ? 'dark' : 'light'} meets every contrast floor`, async () => {
      await loadTheme(false)
      nativeTheme.shouldUseDarkColors = dark
      const tokens = await theme.resolveTheme()
      expect(tokens.mode).toBe(dark ? 'dark' : 'light')
      const f = FLOORS(tokens, theme)
      for (const [name, value] of Object.entries(f)) expect(value, name).toBeGreaterThanOrEqual(4.5)
      expect(theme.relativeLuminance(tokens['--surface-reader']) > 0.5).toBe(!dark)
    })

    it(`${dark ? 'dark' : 'light'} emits well-formed color tokens`, async () => {
      await loadTheme(false)
      nativeTheme.shouldUseDarkColors = dark
      const tokens = await theme.resolveTheme()
      for (const [key, value] of Object.entries(tokens)) {
        if (!key.startsWith('--')) continue
        expect(value, key).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/)
      }
    })
  }
})

describe('app themes', () => {
  beforeEach(async () => { await loadTheme(false) })

  const THEMES = ['inkwell', 'paper', 'slate', 'forest', 'midnight'] as const
  for (const name of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${name} ${mode}: text, secondary and muted meet 4.5:1 on every surface`, () => {
        const t = theme.appThemeTokens(name, mode)
        expect(t.mode).toBe(mode)
        const surfaces = ['--surface-reader', '--surface-panel', '--surface-canvas', '--surface-chrome', '--surface-raised', '--surface-code'] as const
        for (const s of surfaces) {
          expect(theme.contrastRatio(t['--text-primary'], t[s]), `text on ${s}`).toBeGreaterThanOrEqual(4.5)
        }
        for (const s of ['--surface-reader', '--surface-panel', '--surface-canvas', '--surface-chrome'] as const) {
          expect(theme.contrastRatio(t['--text-secondary'], t[s]), `secondary on ${s}`).toBeGreaterThanOrEqual(4.5)
          expect(theme.contrastRatio(t['--text-muted'], t[s]), `muted on ${s}`).toBeGreaterThanOrEqual(4.5)
          expect(theme.contrastRatio(t['--accent'], t[s]), `accent on ${s}`).toBeGreaterThanOrEqual(3)
        }
        expect(theme.contrastRatio(t['--accent-contrast'], t['--accent'])).toBeGreaterThanOrEqual(4.5)
        expect(theme.contrastRatio(t['--selection-text'], t['--selection-bg'])).toBeGreaterThanOrEqual(4.5)
        expect(t['--surface-code']).not.toBe(t['--surface-reader'])
      })
    }
  }

  it('inkwell equals the original fallback palette', () => {
    const light = theme.appThemeTokens('inkwell', 'light')
    expect(light['--surface-reader']).toBe('#fbf8f1')
    expect(light['--surface-chrome']).toBe('#f7f3ec')
    expect(light['--text-primary']).toBe('#1c2b31')
    expect(light['--accent']).toBe('#1b6366')
    const dark = theme.appThemeTokens('inkwell', 'dark')
    expect(dark['--surface-reader']).toBe('#171b1d')
    expect(dark['--text-primary']).toBe('#f4eee3')
    expect(dark['--accent']).toBe('#67b5b3')
  })

  it('the choice drives the fallback: mode forced, theme applied, bad values refused', async () => {
    nativeTheme.shouldUseDarkColors = false
    expect(theme.setAppearance('dark', 'paper')).toBe(true)
    let t = await theme.resolveTheme()
    expect(t.mode).toBe('dark')
    expect(t['--surface-reader']).toBe('#1e1a15')
    expect(theme.setAppearance('system', 'slate')).toBe(true)
    t = await theme.resolveTheme()
    expect(t.mode).toBe('light') // system follows the host
    expect(t['--surface-reader']).toBe('#f7f9fb')
    expect(theme.setAppearance('neon', 'paper')).toBe(false)
    expect(theme.setAppearance('dark', 'nope')).toBe(false)
    expect(theme.getAppearance()).toEqual({ appearance: 'system', theme: 'slate' })
  })

  it('an Omarchy theme wins over the picker', async () => {
    await loadTheme(true)
    await writeColors('mode = "dark"\nbackground = "#111111"\nforeground = "#eeeeee"\n', 'omarchy-x')
    theme.setAppearance('light', 'forest')
    const t = await theme.resolveTheme()
    expect(t.themeName).toBe('omarchy-x')
    expect(t.mode).toBe('dark')
  })
})

describe('Omarchy theme resolution', () => {
  beforeEach(async () => { await loadTheme(true) })

  it('light theme: surfaces are ranked by contrast, not by key name', async () => {
    // In light themes the "lighter_background" key is actually the DARKEST step.
    await writeColors([
      'mode = "light"',
      'foreground = "#3b3b3b"',
      'background = "#f4efe6"',
      'dark_background = "#fbf8f1"',
      'darker_background = "#ece6da"',
      'lighter_background = "#d9d1c2"',
      'accent = "#1b6366"'
    ].join('\n'))
    const t = await theme.resolveTheme()
    const lum = (hex: string) => theme.relativeLuminance(hex)
    // Reader is the highest-contrast (lightest) surface even though no key named it so.
    expect(t['--surface-reader']).toBe('#fbf8f1')
    const ordered = [t['--surface-reader'], t['--surface-panel'], t['--surface-canvas'], t['--surface-chrome']]
    for (let i = 0; i < 3; i += 1) {
      expect(theme.contrastRatio('#3b3b3b', ordered[i])).toBeGreaterThanOrEqual(theme.contrastRatio('#3b3b3b', ordered[i + 1]))
    }
    expect(ordered).toContain('#d9d1c2')
    expect(lum(t['--surface-reader'])).toBeGreaterThan(lum('#d9d1c2'))
    expect(t['--surface-chrome']).toBe('#d9d1c2')
    expect(t.mode).toBe('light')
    expect(t.themeName).toBe('test-theme')
  })

  it('dark theme: reader is the highest-contrast (darkest) step against a light foreground', async () => {
    await writeColors([
      'foreground = "#e6e1cf"',
      'background = "#1b1b1b"',
      'dark_background = "#101010"',
      'darker_background = "#0a0a0a"',
      'lighter_background = "#2a2a2a"'
    ].join('\n'))
    const t = await theme.resolveTheme()
    expect(t.mode).toBe('dark')
    expect(t['--surface-reader']).toBe('#0a0a0a')
    expect(t['--surface-chrome']).toBe('#2a2a2a')
  })

  it('mode cascade: mode key, then theme_type, then light.mode marker, then luminance', async () => {
    const base = 'foreground = "#222222"\nbackground = "#fafafa"\n'
    await writeColors(`mode = "dark"\n${base}`)
    expect((await theme.resolveTheme()).mode).toBe('dark')
    await writeColors(`theme_type = "dark"\n${base}`)
    expect((await theme.resolveTheme()).mode).toBe('dark')
    await writeColors(`mode = "bogus"\ntheme_type = "light"\n${base}`)
    expect((await theme.resolveTheme()).mode).toBe('light')
    await writeColors(base)
    expect((await theme.resolveTheme()).mode).toBe('light') // luminance
    await writeColors('foreground = "#eeeeee"\nbackground = "#101010"\n')
    expect((await theme.resolveTheme()).mode).toBe('dark')
    await writeFile(path.join(home, '.local', 'state', 'omarchy', 'current', 'theme', 'light.mode'), '')
    expect((await theme.resolveTheme()).mode).toBe('light') // marker beats luminance
  })

  it('enforces floors on awkward themes (low-contrast fg, muted, accent, selection)', async () => {
    await writeColors([
      'foreground = "#8a8a8a"',
      'background = "#999999"',
      'muted = "#9a9a9a"',
      'accent = "#777777"',
      'selection = "#888888"'
    ].join('\n'))
    const t = await theme.resolveTheme()
    const f = FLOORS(t, theme)
    expect(f.textPrimaryVsReader).toBeGreaterThanOrEqual(4.5)
    expect(f.accentContrast).toBeGreaterThanOrEqual(4.5)
    expect(f.selection).toBeGreaterThanOrEqual(4.5)
    expect(f.mutedPanel).toBeGreaterThanOrEqual(4.5)
    expect(f.mutedChrome).toBeGreaterThanOrEqual(4.5)
  })

  it('a minimal theme (only a background) still yields four distinct surfaces and passes floors', async () => {
    await writeColors('background = "#1d2021"\n')
    const t = await theme.resolveTheme()
    expect(new Set([t['--surface-reader'], t['--surface-panel'], t['--surface-canvas'], t['--surface-chrome']]).size).toBe(4)
    for (const [name, value] of Object.entries(FLOORS(t, theme))) expect(value, name).toBeGreaterThanOrEqual(4.5)
  })

  it('an empty colors.toml, or one of junk, does not throw', async () => {
    await writeColors('')
    expect((await theme.resolveTheme()).mode).toBe('dark')
    await writeColors('}}}{{{ ===\n[[[')
    const t = await theme.resolveTheme()
    expect(t['--text-primary']).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('invalid color values are ignored in favour of defaults', async () => {
    await writeColors('foreground = "red"\nbackground = "#12"\naccent = "nope"\nmode = "dark"')
    const t = await theme.resolveTheme()
    expect(t['--accent']).toBe('#5fb08a')
    expect(t['--text-primary']).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('falls back to the system palette when colors.toml is missing', async () => {
    nativeTheme.shouldUseDarkColors = false
    const t = await theme.resolveTheme()
    expect(t.themeName).toBe('system-light')
  })

  it('theme name falls back to "unknown" when theme.name is absent', async () => {
    await writeColors('mode = "dark"\nbackground = "#111111"\nforeground = "#eeeeee"\n')
    await rm(path.join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'))
    expect((await theme.resolveTheme()).themeName).toBe('unknown')
  })

  it('derived accent tokens relate to the accent', async () => {
    await writeColors('mode = "dark"\nbackground = "#111111"\nforeground = "#eeeeee"\naccent = "#ff8800"\n')
    const t = await theme.resolveTheme()
    expect(t['--accent']).toBe('#ff8800')
    expect(t['--caret']).toBe('#ff8800')
    expect(t['--accent-tint']).toBe('rgba(255, 136, 0, 0.16)')
    expect(t['--accent-hover']).not.toBe(t['--accent'])
  })
})
