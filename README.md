# Inkwell for Windows

Inkwell is a calm, local-first Markdown reader and editor for Windows. It keeps
the original editorial design and feature set while using Windows-native window
controls, filesystem dialogs, paths, trash, theme detection, and packaging.

## What it does

- Keep several folders of Markdown in one library.
- Reopen your folders, recent files, and active document on launch.
- Open, rename, duplicate, reveal, copy the path of, or recycle local files.
- Create drafts and save them as `.md` files in your Documents folder.
- Switch between focused reading, source editing, and split view.
- Use focus writing without losing the current view mode.
- Render GitHub-flavored Markdown, including tables and task lists.
- Navigate long documents with the generated outline.
- Follow the Windows light or dark setting without restarting.
- Work locally with no account or cloud service.

## Install for development

Requirements:

- Windows 10 or Windows 11
- Node.js 22 or newer
- Corepack, included with Node.js

The same commands work in PowerShell, Command Prompt, and Windows Terminal:

```powershell
corepack enable
pnpm install
pnpm dev
```

Useful checks:

```powershell
pnpm typecheck
pnpm build
pnpm preview
```

The development commands use the project-local Electron runtime and do not
require Bash, WSL, a system Electron package, or Unix environment syntax.

## Build Windows packages

```powershell
pnpm package:windows           # x64 NSIS installer
pnpm package:windows:arm64     # Arm64 NSIS installer
pnpm package:windows:portable  # x64 portable executable
```

Artifacts are written to `release/`. The installer creates Start Menu and
desktop shortcuts and registers Inkwell as an available editor for `.md`,
`.mdx`, and `.markdown` files. It installs per-machine and may request
administrator approval. The portable build changes no file associations.

Production releases should be code-signed before distribution so Windows can
identify the publisher.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New note |
| `Ctrl+O` | Open Markdown file(s) |
| `Ctrl+Shift+O` | Add a folder to the library |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save as |
| `Ctrl+W` | Close document (drafts, recent and Ephy notes) |
| `Ctrl+Shift+D` | Duplicate |
| `Ctrl+Shift+R` | Show in Explorer |
| `Ctrl+Alt+C` | Copy path |
| `Ctrl+Delete` | Move to Recycle Bin |
| `Ctrl+F` / `Ctrl+H` | Find / Replace |
| `F3` / `Shift+F3` | Find next / previous |
| `Ctrl+E` | Use selection for find |
| `Ctrl+Shift+L` | Find in documents |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Read / Split / Write view |
| `Ctrl+B` | Toggle the library |
| `Ctrl+\` | Toggle the outline |
| `Ctrl+Shift+F` | Focus writing |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / actual size |
| `F11` | Full screen |
| `Ctrl+Alt+A` | Show / hide the agent panel |
| `Ctrl+Shift+E` | Open from Ephy (when Ephy is enabled) |
| `Escape` | Leave focus writing, otherwise close the outline |
| `Alt` | Reveal the menu bar (hidden by default) |

You can also pass a file directly:

```powershell
Inkwell.exe "C:\Users\me\Documents\notes.md"
```

Launching another Markdown file while Inkwell is open raises the existing
window and adds that file to the library.

## Windows behavior

- Paths are compared case-insensitively and both drive-letter and UNC paths are
  supported.
- Rename validation rejects reserved names such as `CON`, `NUL`, `COM1`, and
  characters Windows does not permit in filenames.
- New notes default to the current user's Documents folder.
- Delete actions use the Windows Recycle Bin and can be restored there.
- The app uses a native Windows frame, including move, resize, maximize, snap,
  and system-menu behavior.
- The palette tracks the Windows app light/dark preference while retaining
  Inkwell's typography, spacing, and editorial color character.

## Updates

Once a day, Inkwell optionally checks the GitHub Releases of
`mrelph/InkwellWindows` for a newer version. The check sends no document
names, contents, or filesystem paths and fails silently when offline. When an
update is available the status bar offers it; the installer is downloaded,
checked against its published SHA-256, and run when you choose Restart to
update. Help ▸ Check for Updates… always answers in a message box, and Help ▸
Check Automatically turns the daily check off.

To disable it for future terminals and launches regardless of the menu setting:

```powershell
setx INKWELL_NO_UPDATE_CHECK 1
```

## Project structure

- `src/` — React application and editorial interface.
- `src-electron/` — Electron shell, filesystem IPC, state, theming, and update check.
- `build/` — source artwork and Windows icon.
- `packaging/` — retained Linux packaging for upstream compatibility.
- `scripts/` — retained Linux development helper; Windows scripts do not use it.

`DESIGN.md` remains the authority for the visual system. `THEMING.md` documents
how Windows system mode and the upstream Omarchy integration resolve into the
same design-token contract.
