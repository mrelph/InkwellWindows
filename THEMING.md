# Theming: Windows and Omarchy Theme Adaptation

Inkwell follows the Windows app light/dark setting and retains the upstream
Omarchy palette integration on Linux. This document is the authority for the
token vocabulary and derivation rules. `DESIGN.md` remains the authority for
everything that is *not* color (typography, spacing, layering, motion, shape).

## Principle

**Color is theme-driven. Structure is not.** Inkwell's identity lives in its
editorial typography, its generous reading measure, tonal surface layering, and
hairline rules — not in specific hex values. A theme change repaints Inkwell; it
never restructures it.

Mode is **theme-follow for action color**: one theme accent (`--accent`) does all
*action* work — Save, selection, links, focus. Hierarchy between actions is
expressed through *treatment* (filled / tinted / ghost), never through a second
action hue. This is DESIGN.md's Accent Rarity Rule: one action color, one job at
a time.

Beside it sit DESIGN.md's two **identity accents**, which are brand constants
rather than theme colors and are never used for actions in general: **amber**
is the New note invitation and **coral** marks document identity. They match
Inkwell for Mac (`Palette.amber` / `Palette.coral`). See "Identity accents"
below for their tokens and the only places they may appear.

## Source of truth

On Windows, Electron's `nativeTheme.shouldUseDarkColors` selects the light or
dark Inkwell palette. The `updated` event re-resolves the tokens immediately
when the system setting changes.

On Omarchy, palette comes from the active theme's `colors.toml`:

```
~/.local/state/omarchy/current/theme/colors.toml
```

Note this is XDG **state**, not config. `current/theme` is a real directory that
`omarchy-theme-set` replaces wholesale via an atomic `rm -rf` + `mv`, so watch the
containing directory (`~/.local/state/omarchy/current/`) for the `theme` entry
being renamed and for writes to `theme.name` — never watch `colors.toml`'s inode,
which is replaced.

`colors.toml` provides: `mode`, `accent`, `selection`, `muted`, four background
steps, four foreground steps, and 8 base + 6 bright hues. It is preferred over
`alacritty.toml` because it is the only source carrying `mode` and `accent`.

When `~/.local/state/omarchy/` is absent, Inkwell uses its system light or dark
palette and changes nothing else about the layout.

## Omarchy mode detection cascade

Replicate `omarchy-theme-color`'s own order:

1. `mode` field in `colors.toml` (`"light"` / `"dark"`)
2. legacy `theme_type` field
3. legacy `light.mode` marker file in the theme directory
4. relative luminance of `background` (≥ 0.5 → light)
5. default to dark

Set `color-scheme: light|dark` on the root element so scrollbars, form controls,
and native widgets follow, and drop the hardcoded
`<meta name="color-scheme" content="light">` from `index.html`.

## Surface derivation — the inversion trap

The four background steps are **not** ordered consistently between modes:

| theme | `background` | `dark_background` | `darker_background` | `lighter_background` |
| --- | --- | --- | --- | --- |
| osaka-jade (dark) | `#111c18` | `#0c1512` | `#090f0d` | `#23372B` (lighter) |
| flexoki-light (light) | `#FFFCF0` | `#f2efe4` | `#e5e2d8` | `#E6E4D9` (**darker**) |

In a light theme `lighter_background` is *darker* than `background`. Mapping
surfaces by name therefore inverts light themes.

**Rule: assign surfaces by measured contrast against the text color, never by
name.** Compute the WCAG contrast ratio of each of the four background steps
against the resolved foreground, sort descending, and assign:

| rank (contrast vs text) | token | role |
| --- | --- | --- |
| 1 — highest | `--surface-reader` | the reading surface; the document gets the clearest contrast |
| 2 | `--surface-panel` | sidebar, outline, editor panel |
| 3 | `--surface-canvas` | gutter behind panels, split divider field |
| 4 — lowest | `--surface-chrome` | header and status bar; recedes |

This yields the correct result in both modes automatically: a near-black reading
surface with lifted chrome in osaka-jade, and a white page with warm-gray chrome
in flexoki-light. It also satisfies DESIGN.md's "give documents the clearest
contrast" and preserves tonal layering instead of flattening every surface to one
value (the mistake Omarchy's own generated `obsidian.css` makes).

If fewer than four distinct values exist, synthesize the missing steps by mixing
the nearest surface toward or away from the foreground in small perceptual steps.

## Token vocabulary

All tokens are CSS custom properties on `:root`. `styles.css` must reference only
these — no raw color literals anywhere below the `:root` block, in it or in any
co-located stylesheet.

**Surfaces**

- `--surface-reader` — reading pane
- `--surface-panel` — sidebar / outline / editor panels
- `--surface-canvas` — behind panels, split field
- `--surface-chrome` — document header, status bar
- `--surface-raised` — hover and selected sheet; derived by shifting `--surface-panel` one step toward `--surface-reader`
- `--surface-code` — fenced code block background; must be distinct from `--surface-reader`

**Text**

- `--text-primary` — body and headings
- `--text-secondary` — document titles and chrome labels
- `--text-muted` — metadata, small labels, status bar
- `--text-inverse` — text on an accent fill

**Lines**

- `--line-hairline` — warm rule separating regions
- `--line-strong` — border of an active or selected item

**Accent (the single action hue, theme-derived)**

- `--accent` — the one action color
- `--accent-hover` — one perceptual step from `--accent`
- `--accent-contrast` — text/icon color on an accent fill, contrast-checked
- `--accent-tint` — low-alpha accent for callouts and selected backgrounds
- `--accent-ring` — focus ring

**Identity accents (fixed, not theme-derived)**

- `--identity-amber` (`#f2b86f`) — fill of the New note button. Nothing else.
- `--identity-amber-ink` (`#1c2b31`) — text and icon on that fill. A fixed ink,
  deliberately *not* `--text-primary`: the pair is about 8:1 in both modes,
  whereas theme text turns light in a dark theme and would vanish on amber.
- `--identity-coral` (`#e56d40`) — document identity. Used raw only for tints
  and borders: the header's document badge (12% fill, 30% border) and the New
  note button's edge (35%).
- `--identity-coral-ink` — coral for anything read against a surface: the badge
  glyph, the active row's file icon, the unsaved dot. Derived, not a literal:
  `color-mix(in srgb, var(--identity-coral) 80%, var(--text-primary))`. Leaning
  toward the theme's text color darkens it on light surfaces and lightens it on
  dark ones, so one definition is the contrast-safe variant for both modes
  (about 3.3:1 on the light panel and 5.8:1 on the dark panel, where raw coral
  on the light panel is only 2.5:1).

The three hex literals are written in exactly one place, the `:root` block of
`styles.css`. They are not in `ThemePayload`, so theme injection never replaces
them and an Omarchy theme does not recolor them. If a future theme needs to
(a theme whose surfaces fight amber, say), add them to the token derivation in
`src-electron/theme.ts` with the same contrast floors rather than writing a
second literal in CSS.

Everything else that is accent-colored stays `--accent`. In particular the Ephy
badge and Ephy group label are teal, not coral, as on Mac.

**Editor**

- `--caret` — text caret, `--accent`
- `--selection-bg`, `--selection-text`

**Elevation**

- `--shadow-overlay` — the ambient edge under a panel that overlays the canvas
  (compact outline, undocked agent panel). Fixed; the one shadow that is not
  mixed from a theme token, because a shadow has to stay dark in a dark theme.

## Contrast enforcement

Arbitrary theme pairings cannot be trusted; the current hardcoded palette already
fails AA in places (`.document-item small` at roughly 2.6:1). Enforce at
derivation time, in the main process:

- `--text-primary` vs `--surface-reader` — target 7:1, **require ≥ 4.5:1**. If
  `foreground` fails, try `bright_foreground`, then `light_foreground`, then
  `dark_foreground`, then pure white/black.
- `--text-muted` vs `--surface-panel` **and** `--surface-chrome` — require
  ≥ 4.5:1 (it is used at 10–11px, so the large-text 3:1 allowance does not
  apply). Start from `muted` and blend toward `--text-primary` until it passes.
- `--accent-contrast` vs `--accent` — require ≥ 4.5:1; pick the better of the
  theme's extreme foregrounds, else white/black.
- `--selection-text` vs `--selection-bg` — require ≥ 4.5:1.

A token that cannot satisfy its floor falls back rather than shipping unreadable
text. Contrast is a correctness property here, not a preference.

## Headings stay ink

Omarchy's generated `obsidian.css` colors `h1`–`h6` red / green / yellow /
accent / magenta. Inkwell deliberately does not: headings use `--text-primary`.
Per DESIGN.md, the reader's hierarchy is carried by size, weight and spacing, and
accent color stays functional rather than decorative. Inline code and links may
take `--accent`.

## Runtime plumbing

1. Main process resolves tokens on startup, listens to `nativeTheme`, and watches
   `~/.local/state/omarchy/current/` when that directory exists.
2. On change, re-resolve, re-run contrast enforcement, and
   `webContents.send('theme:changed', tokens)`.
3. Preload exposes an `onThemeChange` subscription (today it only exposes
   invoke-style calls).
4. Renderer applies tokens via `documentElement.style.setProperty` and sets
   `data-theme-mode`. No rebuild, no reload, no flash.
5. `BrowserWindow.backgroundColor` must also be set from the resolved
   `--surface-chrome`, otherwise a cream flash precedes every dark-theme launch.

## System palettes (non-Omarchy fallback)

The light palette is the original Inkwell palette. The dark palette keeps the
same warm editorial character:

| token | value |
| --- | --- |
| `--surface-reader` | `#fbf8f1` |
| `--surface-panel` | `#e9e2d6` |
| `--surface-canvas` | `#e8e1d5` |
| `--surface-chrome` | `#f7f3ec` |
| `--text-primary` | `#1c2b31` |
| `--text-muted` | `#6b6459` (darkened from DESIGN.md's muted to reach AA) |
| `--line-hairline` | `#d7cfc2` |
| `--accent` | `#1b6366` |
| `--accent-ring` | `#167b81` |

| dark token | value |
| --- | --- |
| `--surface-reader` | `#171b1d` |
| `--surface-panel` | `#202629` |
| `--surface-canvas` | `#272e31` |
| `--surface-chrome` | `#111517` |
| `--text-primary` | `#f4eee3` |
| `--text-muted` | `#b9b0a4` |
| `--accent` | `#67b5b3` |
