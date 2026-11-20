# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is pnpm.

```bash
pnpm install               # install dependencies
pnpm dev                   # Vite dev server + Electron, with tsc watch on the main process
pnpm build                 # tsc-compile src-electron/ and vite-build src/ into dist-electron/ and dist/
pnpm typecheck             # renderer, main and test tsconfigs, no emit
pnpm test                  # vitest: src/**/*.test.ts and src-electron/**/*.test.ts
pnpm preview               # build, then launch the built app
pnpm package:windows       # x64 NSIS installer
pnpm package:windows:arm64 # Arm64 NSIS installer
pnpm package:windows:portable # x64 portable executable
```

There is no linter. `pnpm typecheck`, `pnpm build` and `pnpm test` are the
automated gates (in this environment run pnpm as `corepack pnpm`). Tests cover
DOM-free logic only: `src/lib/*`, the renderer's pure helpers (find, Ephy
wording, responsive chrome, asset paths, reader links, shortcuts incl. AltGr),
and every main-process module that keeps Electron out of its core
(`fileStore.ts`, `theme.ts`, `assetGuard.ts`, `pathRules.ts`,
`trustedDocuments.ts`, `readerLinks.ts`, `appOrigin.ts`, `acp/*` including
end-to-end runs against a fake agent — one through a directory junction —
`ephy/*` against a fake CLI, the updater's release parsing, redirect and
signature rules). `ipc/documents.test.ts` runs the real document handlers
with Electron stubbed and every `node:fs/promises` call recorded, which is
how "no fs call for a UNC path" is proven. Bugs are
fixed by flipping their test to a plain `it`; don't leave `it.fails` behind.

Windows development and packages use the project-local Electron runtime.
`package.json` explicitly allows the `electron` and `esbuild` install scripts so
a normal `pnpm install` produces a runnable checkout without Bash, WSL, or a
system Electron package. The legacy Arch packaging remains under `packaging/`
for upstream compatibility but is not the primary distribution path here.

To run the built app directly for verification: `pnpm preview`.

## Critical invariants

**`vite.config.ts` must keep `base: './'`.** Electron loads the built
`index.html` over `file://`, where absolute `/assets/...` URLs resolve to the
filesystem root and the app renders as a blank window. Dev works either way, so
removing this breaks only production and packaged builds — silently.

**`styles.css` contains no raw color literals below the `:root` block.** Every
color resolves to a CSS custom property so an Omarchy theme change repaints the
app. The `:root` block holds the DESIGN.md default palette, used off Omarchy and
as the pre-injection paint. Adding a hex literal elsewhere creates a spot that
ignores the user's theme.

**No new npm dependencies without checking network access.** This environment has
none; `pnpm add` fails silently or no-ops. The theme resolver hand-rolls its TOML
reading for this reason. Removing a dependency is risky too: it re-links
`electron` and can break its install, which is why the unused
`@fontsource/source-serif-4` is still in `package.json` (follow-up).

**The preload is ONE self-contained file.** The renderer is sandboxed, so
`src-electron/preload.ts` may `import type` from `ipc/contract.ts` and nothing
else at runtime; channel names are string literals. It `satisfies
InkwellBridge`, so a shape drift fails typecheck, and
`src-electron/contract.integrity.test.ts` fails if a channel literal in the
preload is missing from `CHANNELS` or vice versa (and if a runtime import
appears). A new channel means: the type in `contract.ts`, the name in
`CHANNELS`, the preload line, then the main-side handler.

**The CSP is generated, and strict in production.** `index.html` carries a
`%INKWELL_CSP%` placeholder that the `inkwell-csp` plugin in `vite.config.ts`
fills: `default-src 'self'`, `img-src 'self' inkwell-asset:`, `style-src
'self'`, `font-src 'self'`, `connect-src 'self'`, no objects, frames, base or
form targets. Only the dev server adds the HMR websockets and `'unsafe-inline'`
styles (Vite's client injects `<style>` for CSS HMR). React `style={}` props go
through the CSSOM, which style-src does not govern, so production needs no
inline allowance. Fonts are never inlined as `data:` URLs
(`build.assetsInlineLimit`), because that would need `font-src data:`. No remote
image ever loads: the reader shows a placeholder instead.

**The renderer is untrusted; main is the authority for every path.** Treat
the page as potentially compromised (the agent can run commands). Every
renderer→main channel is registered through `ipcGuard.ts` (`handle` / `on`),
which refuses any sender that is not the app window's main frame showing the
app's own page (`appOrigin.isAppUrl`); `contract.integrity.test.ts` fails if a
module calls `ipcMain.handle/on` directly. Paths the renderer names are then
checked by `trustedDocuments.ts`, LEXICALLY, before any fs call:

- **Write** (`document:save`, `file:rename|duplicate|trash`): only a Markdown
  file (`md`/`mdx`/`markdown`) main itself handed out — opened through a
  dialog, on argv / from a second instance, found walking a library folder,
  chosen in a Save dialog, or produced by main's own rename / duplicate. The
  non-walk ones persist in `trusted-documents.json`, a file only main writes
  (library.json is renderer-written and never grants this). A save to any
  other Markdown path goes through a Save dialog seeded with it; a
  non-Markdown path is refused outright.
- **Read** (`document:read`, Open Recent, reveal): writable documents, the
  Recent files / last note library.json held at startup, reader-link targets
  (`document:open-link`, resolved by main in `readerLinks.ts` against a note
  it vouched for), and Markdown lexically inside a library folder.
- **Library folders**: only from the Add Folder dialog or the agent's
  notes-folder offer (both through `trustAndReadLibraryFolder`, trusted in
  memory the moment main has the folder; main then asks the renderer to adopt
  it over `library:adopt-folder`, whose reply grants nothing) or library.json as main loaded it at startup. Drive
  roots, the home folder and folders holding it are refused. `state:save` can
  drop a folder, never add one; `document:read-folder` reads only these.
- **Integrations**: only the person can turn the agent or Ephy ON, and only
  in main. There is no renderer setter and there must never be one. The page
  may *request* it (`agent:request-enable` / `ephy:request-enable`, from the
  Settings popover); `ipc/settingsRequests.ts` then shows a native,
  window-modal `dialog.showMessageBox` (Turn On / Cancel, Cancel the default)
  that the page cannot see or answer, and enables only on that click. One
  confirmation at a time across both integrations, plus a short quiet period
  after a Cancel, so a compromised page cannot stack or machine-gun dialogs;
  the channels read no arguments. Turning one OFF is a direct request
  (`agent:disable` / `ephy:disable`): it only removes capability. The
  Integrations menu's own checkboxes act in main as before. So a compromised
  page still cannot start a command-running agent or publish as the user.

Keep new document handlers on these checks; never `trustDocument` a path just
because the renderer sent it.

**Network paths are refused before any fs call.** On Windows even a realpath
or stat of `\\server\share\x` connects over SMB/WebDAV and offers the user's
NTLM hash. `pathRules.ts` treats UNC, `\\?\` / `\\.\` device paths and drive
letters mapped to a share (`networkDrives.ts`, from `net use`) as network,
and every handler — documents, assets, the agent sandbox, reader links — lets
one through only when it is lexically inside a root that is itself on that
share (a library folder the user chose, or the folder of a note main opened
there). The renderer's image classifier never even requests one.

**Note images follow the Mac (`Paths.resolveImage`).** Images load through
`inkwell-asset://local/?f=<file>&r=<note folder>` (`assets.ts` +
`assetGuard.ts`): any image on a LOCAL drive — relative paths with `../`,
absolute and `~` paths included — as long as it has an image extension
(checked before and after the real path is resolved), is under the 40 MB cap,
and is served with `nosniff` and a locked-down response CSP. Remote, `data:`
and `javascript:` sources stay placeholders. A network image loads only under
the network rule above (`r` counts only when it is the folder of a document
main vouched for). Why local-anywhere is safe against a compromised renderer:
it can read local image files, but the page CSP (`img-src 'self'
inkwell-asset:`, `connect-src 'self'`, no frames, forms or objects) leaves it
no channel to send them anywhere.

## Architecture

Local-first Markdown reader/editor: an Electron shell around a single-page React
app. No backend; all persistence is filesystem I/O via IPC. Inkwell itself makes
one kind of outbound request — the update check and, when asked, the installer
download, both against GitHub Releases in `update.ts` / `updateInstaller.ts`.
The optional integrations (an agent harness, the Ephy CLI) are separate
processes that do their own networking, and are off by default.

**Main process** (`src-electron/`). `main.ts` owns the app lifecycle, the
window, the unsaved-changes close guard, the single-instance lock, argv file
opening (and the jump list's `--new-note`), full screen, the external-link
policy (`setWindowOpenHandler` + `will-navigate` hand safe schemes to
`shell.openExternal` and deny everything else), and the settings push events.
Every other concern registers itself from its own module, once, rebinding to
the newest window on later calls:

- `ipc/contract.ts` — the whole renderer↔main contract: every payload type,
  `READER_FONT_VALUES`, the `InkwellBridge` shape and `CHANNELS`. The preload
  `satisfies InkwellBridge`; `src/vite-env.d.ts` re-exports the types as
  renderer globals.
- `preload.ts` — `window.inkwell`, one self-contained file (see Critical
  invariants). Subscription methods return an unsubscribe function.
  `contextIsolation: true`, `nodeIntegration: false`.
- `ipc/documents.ts` — every `document:*`, `file:*`, `clipboard:*` and
  `state:*` handler, over the Electron-free helpers in `fileStore.ts` (atomic
  writes, folder walk that skips dot-dirs and `node_modules`, lenient UTF-8,
  file-name rules). Asks `trustedDocuments.ts` before touching any path the
  renderer names, and records what it hands out there (see Critical
  invariants). `initialiseDocumentTrust()` loads main's record before the
  window exists.
- `ipcGuard.ts` / `appOrigin.ts` — the sender check every channel goes
  through, and which URL is the app (the built `index.html`, or — unpackaged
  only — a loopback `http://` dev server; `--dev-server=` and
  `VITE_DEV_SERVER_URL` are ignored in a packaged build).
- `pathRules.ts` / `networkDrives.ts` / `readerLinks.ts` — the lexical path
  rules (network detection, broad folders), the mapped-drive list, and main's
  resolution of reader links to local notes.
- `state.ts` — `library.json`: folder sources, recent files, last active path,
  reader font, zoom, view, Ephy links. Every field is re-validated on load and
  written through a temp file, because it is a file the user can open and
  mangle and it must never be able to break startup.
- `settings.ts` — `settings.json`: the agent and Ephy enable toggles, the
  chosen harness, "Include current note", the auto update check, spellcheck.
  Same sanitize-on-load posture. The agent and Ephy enables are turned on
  only by main after the person confirms (the Integrations menu, or a
  Settings request — see Critical invariants); spellcheck, auto-update and
  "Include current note" may also be set by the renderer (low risk).
  `onSettingChange` fires on every real change, whoever made it; `main.ts`
  turns that into `agent:enabled-changed`, `agent:include-note-changed`,
  `ephy:enabled-changed`, `spellcheck:changed` and `update:auto-check-changed`
  for the renderer, and `menu.ts` rebuilds. Never mirror one of these toggles
  in the renderer by polling or on focus.
- `menu.ts` — the application menu (File / Edit / View / Integrations / Help).
  It is registered but never drawn as a strip: on Windows the window has
  Inkwell's own title bar and Electron cannot show a menu bar there at all
  (`isMenuBarVisible()` stays false), so the menu is *popped up* — Settings ▸
  All menu commands…, a tap of Alt, or F10, all through `menu:popup`. Built
  from the `MenuState` the renderer pushes on `menu:state` (including the
  Reading Font list from `src/fonts/readerFonts.ts` with "(not installed)"
  marks) and from settings. Clicks go back as `menu:command`. Accelerators
  are display-only (`registerAccelerator: false`): the renderer's shortcut
  table is the one dispatcher. Also the taskbar jump list: Recent
  (`app.addRecentDocument`) and the "New note" task.
- `ipc/settingsRequests.ts` — what the header's Settings popover may ask of
  main: the enable *requests* and their native confirmation, the direct
  disables, `menu:popup` and `app:about`. Everything it needs is injected by
  `main.ts`, so `settingsRequests.test.ts` runs the real handlers with
  `electron` stubbed.
- `assets.ts` + `assetGuard.ts` + `trustedDocuments.ts` — the `inkwell-asset`
  scheme for note images (see Critical invariants). The library folders it
  uses are main's in-memory record, never a cached read of library.json.
- `contextMenu.ts` — spelling suggestions, Add to Dictionary, edit roles, the
  spellcheck toggle.
- `update.ts` / `updateRelease.ts` / `updateInstaller.ts` / `ipc/update.ts` —
  updates from the **GitHub Releases** of `mrelph/InkwellWindows`
  (`/releases/latest`, one Release per `vX.Y.Z` tag carrying
  `Inkwell-Setup-<ver>-<arch>.exe` and a `.sha256`), via `net.fetch` so a
  system proxy is honoured. Silence is the default for the daily check: opted
  out, up to date, dismissed and unreachable all say nothing, and a *failed*
  check does not stamp `checkedAt`. Help ▸ Check for Updates… always answers,
  in a native message box (Mac's alert), so it is heard even in focus mode;
  "Install" there, or the status-bar notice, downloads the installer (every
  redirect hop checked against GitHub's asset hosts before it is followed,
  at most five), verifies its SHA-256 (and Authenticode when the running app
  is signed; a packaged build whose own signature probe fails refuses the
  install — only a definite `NotSigned` skips that check), and "Restart
  to update" runs it silently and relaunches — refused while work is unsaved
  (`unsavedChanges.ts`). The portable build and a dev checkout open the
  release page instead. Every URL is built in main from the validated release;
  the page never supplies one.
- `theme.ts` — resolves the Windows light/dark palette or the active Omarchy
  theme into design tokens, and watches for changes.
- `acp/` — the optional agent panel's main side: an Agent Client Protocol
  client over a child process's stdio. File access is sandboxed to the library
  folders and the open note's folder (only folders and notes main vouched
  for; a network path is refused before any fs call), writes ask first with a
  diff, and ANY open note or an unsaved draft (matched by document id) is read
  and edited through its renderer buffer, never on disk. `agent:set-context`
  carries every open note's path; `acp/spellings.ts` maps each real path back
  to the renderer's spelling (Mac `document(atResolvedPath:)`), so a note
  opened through a junction, mapped drive or short name still reaches its
  buffer. A write that does land on disk is announced on `agent:file-written`,
  under the renderer's spelling of its library folder, so that folder refreshes.
- `ephy/` — the optional Ephy integration through the `ephy` CLI, arguments
  as an array, content over stdin/stdout only.

**Renderer** (`src/`). `app/App.tsx` holds all library state and composes the
layout; presentational pieces live in `components/`, the editor in `editor/`
(`EditorHandle` is defined once, in `editor/Editor.tsx`), the reader in
`reader/`, the agent panel in `agent/`, Ephy in `ephy/`, update UI in
`update/`, fonts in `fonts/`, DOM-free logic in `lib/`. Commands go through one
registry (`app/commands.ts`) and one keyboard dispatcher (`app/shortcuts.ts`);
menu clicks and the jump list arrive as the same commands. Integrations reach
the library only through `app/activeDocument.tsx` and `app/integrations.tsx`
(`IntegrationsContext`: documents, Ephy links, `applyEditTo`, `rekeyDocument`,
`resetUndo`, the pushed `agentEnabled` / `ephyEnabled`). When `window.inkwell`
is undefined (running outside Electron) file operations no-op.

A Ctrl shortcut never fires while Alt is down unless it asks for Alt, and a
Ctrl+Alt one ignores AltGr (`getModifierState('AltGraph')`): Windows reports
AltGr as Ctrl+Alt, and AltGr is how many layouts type `\`, `@`, `{`. Reader
links never navigate the app: `src/reader/links.ts` sends `#slug` to a scroll,
web/mail links to the desktop, and relative / `file:` Markdown links to main
(`document:open-link`), which resolves and validates them (Mac `openLink`).

**Renderer data model:** all open documents live in one `documents: MarkdownDoc[]`
array; `activeId` selects the current one, and may be `null` — an empty library
is a legitimate state, not an error, and the canvas has an empty view for it.
Ids are keyed on path (`file:<path>`) so reopening a file resolves to the
existing entry instead of duplicating it. A rename changes the id, so it also
has to move `activeId` and the recent entry.

**Nothing replaces the library.** Every open path — open-file, add-folder, argv,
second-instance, duplicate — appends. Each document carries a `sourceId` naming
the group it belongs to, and the sidebar renders one group per source in a fixed
order: folder sources, then `drafts`, then `ephy`, then `recent` (Mac order).
Ephy notes are in memory only — never in `library.json`, never in Recent.

- Folder sources are *sources*, not workspaces: adding one never displaces
  another, up to `MAX_FOLDERS`. Overlapping folders are refused rather than
  merged, because a nested source would list the same file under two headings
  and the dedupe by path would silently drop one of them.
- `sourceForPath` decides where an opened file lands: inside an added folder it
  joins that folder's group, otherwise `recent`. Saving a draft runs it too, so
  a new note saved into an added folder appears there.
- Only `drafts`, `ephy` and `recent` rows can be closed (Ctrl+W). Closing a file that
  a folder source lists would be meaningless — the folder still holds it — so
  those rows offer *Move to trash* and the group offers *Remove from library*
  instead. Removing a source never touches disk.
- There are no sample documents (removed to match the Mac). An empty library
  shows the empty canvas: "Open a note, add a folder, or start writing."

An earlier version treated a folder as a workspace that *replaced* everything
open, which is why `confirmDiscard` exists. It is still used, but now only for
closing dirty rows and removing a source that holds them.

**Persistence** is `state.ts` behind a 400ms debounce in the renderer, gated on a
`restored` flag so the first render cannot save an empty library over a real one.
A folder that has gone from disk is dropped silently on restore; a recent file
that has gone is dropped when the user tries to open it.

**View modes** (`read`/`split`/`write`) are driven by CSS grid classes on
`.document-canvas`, not separate components. The view is persisted in
`library.json`.

**Focus** is an orthogonal `focusMode` flag, not a fourth view mode — focus +
read, focus + split, and focus + write are all legitimate combinations; toggling
it never changes `view`. It hides the sidebar, outline and status bar via
`.focus-mode`, and `Escape` exits it *before* falling through to closing the
outline. One inversion to be aware of: below 820px a split normally collapses
to the reader, but in focus + split it must collapse to the **editor** instead
— a deliberate bias toward the writing surface in that one narrow combination.

## Layout invariants

**Breakpoints are `data-chrome` tokens, not media queries.** Every breakpoint
compares against the *layout* width — the window at the current zoom (Electron
page zoom shrinks the CSS viewport, so that is already `innerWidth`) less a
docked agent panel — which no `@media` query can know. `useResponsiveChrome`
(`src/app/useResponsiveChrome.ts`, fed `agentOpen` and `focusMode` by App)
computes it and publishes tokens on the root element: `outline-overlay` (≤
1120), `narrow` (≤ 820: library folds, a split draws one pane),
`status-compact` (≤ 700), `small` (≤ 560) and `agent-overlay` (the agent panel
cannot dock and overlays the canvas). `styles.css` keys on
`:root[data-chrome~='…']`. Panels the app folded come back when room returns; a
panel closed by hand stays closed (`foldPanels`). The header's eight collapse
stages are measured, not breakpoint-driven (`useHeaderStage`). A new width
breakpoint belongs in `chromeTokens`, never in an `@media (max-width)` rule
(only the `max-height` and reduced-motion queries remain media queries).

`grid-template-columns` is declared exactly once, on `.app-shell`, and driven by
`--col-sidebar` / `--col-outline` / `--col-agent`. The collapse-state rules live in a block at
the very end of `styles.css`, carry two classes, and must stay last: a
single-class rule placed before a breakpoint's `.app-shell` rule loses at equal
specificity and leaves a dead column where the panel used to be. That was a real
bug (a 230px gutter between 821–1120px), so don't re-introduce per-breakpoint
column declarations.

Never hide the only control that can restore a panel. Hiding `.outline-toggle`
above 1120px while leaving the in-panel close button visible made closing the
outline a one-way door with a pointer. The toggle is now always visible; the
in-panel close appears only when the outline is an overlay.

Each region is pinned to its track (`.sidebar` → 1, `.workspace` → 2,
`.outline` → 3, `.agent-panel` → 4). This is load-bearing, not tidiness: a `display: none` panel
stops occupying a grid cell, so under auto-placement the workspace slides into
the collapsed panel's zero-width track while the real track sits empty.

`.workspace` needs an explicit `grid-template-columns: minmax(0, 1fr)`. With
only an implicit `auto` column the track is sized by its widest child's
min-content — the header's button row — so the workspace grows past its own grid
track and the canvas overflows with it.

**Verify layout by measuring element widths, not track sizes.** Correct
`gridTemplateColumns` does not imply correct layout: both bugs above produced
perfect track values while the canvas was visibly wrong, and a harness checking
only tracks reported a false pass. Assert `canvas <= workspace` and
`workspace == viewport - sidebar - outline - agent`.

Two ways to check, in increasing fidelity:

- Offscreen: load `dist/index.html` in a hidden `BrowserWindow`, drive it with
  synthetic `KeyboardEvent`s, and measure `getBoundingClientRect()`. Such a
  harness needs `app.on('window-all-closed', () => {})` or Electron quits as
  soon as the first probe window is destroyed.
- Live: launch with `--remote-debugging-port=9222` and drive the real window via
  `Runtime.evaluate` over the DevTools protocol (Node's global `WebSocket` is
  enough). This is the one that catches real-DPR and real-theme issues.
- Live but invisible: the same thing plus `--ozone-platform=headless` and
  `--user-data-dir=<temp>`. The real main process, preload and IPC all run, and
  nothing appears in the user's tiling layout or touches their real library.
  `Emulation.setDeviceMetricsOverride` then resizes the CSS viewport, so every
  breakpoint can be measured from the one window. Two limits: `--user-data-dir`
  is also how you keep the test run out of the real `library.json`, and a native
  dialog (`showMessageBox`, `showOpenDialog`) never resolves headless — it wedges
  the main process, taking the DevTools endpoint down with it, so drive paths
  that end in a dialog by calling the IPC behind it instead.

On Windows there is no headless ozone platform, so the window is real. Pass
`--disable-features=CalculateNativeWinOcclusion
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`: a
window covered by others otherwise reports `visibilityState: hidden`, stops
laying out (resizes are not seen) and never loads `loading="lazy"` images.
Resize the real window from main (`--inspect=<port>` and the Node inspector:
`process.mainModule.require('electron').BrowserWindow…setContentSize`), which
also lets a probe read `Menu.getApplicationMenu()` and click menu items. A full
boot check seeds `library.json` / `settings.json` in the temp user-data dir,
watches the console and `securitypolicyviolation` events from the first script
on (`Page.addScriptToEvaluateOnNewDocument`), and empties `PATH` and the home
folders for the child so that opening the agent panel cannot start a real
harness.

`contextBridge` objects are frozen and `window.inkwell` is non-configurable, so a
probe cannot stub the bridge to fake a file dialog. Reach the add-paths another
way: a second instance with a file argument exercises `document:opened-externally`
against the running window, and a pre-seeded `library.json` exercises restore.

Screenshots are a poor fit here: `grim` captures whatever is composited at the
given coordinates, so it silently grabs unrelated windows when the stack shifts.

## Platform window behavior

On Windows the header is the title bar. The window is `titleBarStyle:
'hidden'` with a `titleBarOverlay` (`main.ts`): no native title strip and no
menu strip, but the native minimize / maximize / close buttons stay, as a
32px Window Controls Overlay in the top-right corner. Do not replace them
with hand-built controls: they, and the drag region, are what keep Windows
move, resize, snap layouts, the system menu, accessibility and high-DPI
behavior native. `main.ts` repaints the overlay (`setTitleBarOverlay`) with
the theme's `--surface-chrome` and `--text-primary` whenever the theme
changes, and with `--surface-reader` while `MenuState.focusMode` is set,
because that is the header's surface then. Linux retains the upstream
frameless window because Hyprland owns that chrome.

One `.document-header` carries document identity and actions, and on Windows
it is also the window's drag region. All of that is one block in `styles.css`
keyed on `:root[data-titlebar='overlay']` (App sets the token on win32 only),
so Linux gets no `-webkit-app-region` rule:

- The header is stretched over the outline and agent columns
  (`margin-right: calc(-1 * (var(--col-outline) + var(--col-agent)))`) and
  those two panels sit in a second grid row below it, so the header always
  reaches the corner the caption buttons occupy. This rides on the same
  `--col-*` variables as the collapse rules; it declares no
  `grid-template-columns`. An overlaying outline / agent panel spans both rows
  (`grid-row: 1 / -1`) and keeps `top: var(--header-h)`.
- The header's right padding grows by `--wco-reserve`, computed from
  `env(titlebar-area-x)` / `env(titlebar-area-width)`. Those are CSS px, so
  page zoom is already accounted for, and they fall back to 0 with no overlay
  (full screen). Because it is padding, `useHeaderStage` measures it.
- The header is `-webkit-app-region: drag`; every `button`, field, menu and
  dialog inside it is `no-drag`. A new interactive element in the header that
  is none of those needs `no-drag` too, or it will not receive clicks.
- CDP screenshots do not include the caption buttons. To see them, capture
  the window from main (`desktopCapturer.getSources({ types: ['window'] })`).

`minWidth`/`minHeight` are deliberately low (480×360). Hyprland tiles a window to
whatever the layout dictates regardless of these hints, so every breakpoint —
including the `max-height` one — must stay fully operable. Never leave a control
visible but inert; collapsed panels use `display: none` rather than `opacity: 0`
so they cannot hold keyboard focus while invisible.

The runtime Wayland `app_id` is `inkwell`, derived from package.json `name`.
`StartupWMClass` in the desktop entry must match it exactly or window/icon
association breaks. Electron 43 selects Wayland on its own; no ozone flags are
needed (they *were* required on 34).

## Theming

`THEMING.md` is the authority — read it before touching color. `DESIGN.md`
governs everything that is not color.

On Windows, palette mode follows Electron's `nativeTheme` and updates live when
the user changes the system app theme. Inkwell supplies its own light and dark
editorial palettes, then runs both through the same contrast-enforcement path.

On Omarchy, palette comes from
`~/.local/state/omarchy/current/theme/colors.toml` (XDG *state*, not config).
`omarchy-theme-set` replaces the `theme` directory wholesale via `rm -rf` +
`mv`, so watch the containing directory, never `colors.toml`'s inode.

The one trap worth restating: the four background steps are **not** ordered
consistently between modes — in light themes `lighter_background` is *darker*
than `background`. Surfaces are therefore assigned by measured WCAG contrast
against the resolved foreground, never by name. Mapping by name inverts every
light theme.

Contrast floors are enforced at derivation time rather than trusted, because
arbitrary theme pairings routinely fail AA.

## Heading anchors are content-based, on purpose

The outline scanner (`getHeadings`) and the reader's heading renderers are two
independent parsers, and they *will* disagree — a `#` inside a fenced block, a
setext heading. IDs are slugs of heading text, not ordinals, so a disagreement
costs one broken anchor instead of shifting every subsequent one. If you change
slugging on one side, change it on the other; both go through `slugify` +
`inlineToText` + `uniqueId` (src/lib/headings.ts). `uniqueId` records every id
it hands out, so a repeat's suffix never collides with a heading whose own text
slugs to it ("A", "A", "A 1" → `a`, `a-1`, `a-1-1`). The outline's fence
scanner follows CommonMark: a fence closes only on the same marker, at least as
long, with no info string.

## Packaging

The primary targets are NSIS installers for x64 and Arm64, plus an x64 portable
executable. Outputs land in `release/`. The installer is per-machine because
electron-builder's NSIS file associations require that mode; it registers
`.md`, `.mdx`, and `.markdown` while the portable build registers nothing.

`build/icon.ico` is the Windows application icon derived from the original
Inkwell artwork. Keep it in sync if the source SVG or PNG changes. Production
releases should be code-signed; local package validation may remain unsigned.
