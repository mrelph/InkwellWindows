import { lstatSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { isNetworkPath, networkAllowed, stripExtendedPrefix as stripPrefix } from '../pathRules'

/* Decides which files an agent may read or write through fs/*. A port of
   InkwellMac PathSandbox.swift, made Windows-aware.

   A path is allowed only when, after resolving every symlink and junction, it
   sits inside one of the roots (also resolved). Paths are compared by
   component, case-insensitively on Windows. Hidden components (.git, .env,
   agent settings) are refused, and so are roots that are the home folder or a
   drive/filesystem root. On Windows the names Win32 would silently rewrite
   (trailing dot or space, alternate data streams, device names) are refused
   too, because they could name a hidden file by another spelling.

   The pure helpers take `windows` explicitly so the Windows rules are tested
   on any host; the file system calls run on the host. */

export type Denial = 'notAbsolute' | 'outside' | 'hidden' | 'missingFolder' | 'invalidName'

export type Resolution = { ok: true; path: string } | { ok: false; denial: Denial }

export type SandboxOptions = {
  /** Exact paths allowed outside the roots: unsaved notes that live only in
      Inkwell, at the path the agent was told. */
  files?: string[]
  home?: string
  windows?: boolean
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const WINDOWS_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/

/** Whether `path` is absolute in the given flavour. Device paths (`\\?\`,
    `\\.\`), drive-relative paths (`C:x`) and paths with a NUL are not. */
export function isAbsolutePath(path: string, windows: boolean): boolean {
  if (path.includes('\u0000')) return false
  if (!windows) return path.startsWith('/')
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(path)
}

/** The root ("C:", "\\server\share" or "/") and the names below it. */
export function splitPath(path: string, windows: boolean): { root: string; names: string[] } {
  if (!windows) return { root: '/', names: path.split('/').filter(Boolean) }
  const unified = path.replace(/\//g, '\\')
  const unc = /^\\\\([^\\]+)\\+([^\\]+)(.*)$/.exec(unified)
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}`, names: unc[3].split('\\').filter(Boolean) }
  const drive = /^([A-Za-z]:)(.*)$/.exec(unified)
  if (drive) return { root: drive[1], names: drive[2].split('\\').filter(Boolean) }
  return { root: '', names: unified.split('\\').filter(Boolean) }
}

const fold = (value: string, windows: boolean) => (windows ? value.toLowerCase() : value)

/** True when `path` is strictly below `root` (the root itself is not a file). */
export function isBelow(root: string, path: string, windows: boolean): boolean {
  const base = splitPath(root, windows)
  const target = splitPath(path, windows)
  if (fold(base.root, windows) !== fold(target.root, windows)) return false
  if (target.names.length <= base.names.length) return false
  return base.names.every((name, index) => fold(name, windows) === fold(target.names[index], windows))
}

/** The names of `path` that sit below `root`. */
const namesBelow = (root: string, path: string, windows: boolean) =>
  splitPath(path, windows).names.slice(splitPath(root, windows).names.length)

export const isHiddenName = (name: string) => name.startsWith('.')

/** A file or folder name Inkwell lets the agent use. On Windows this refuses
    the spellings Win32 rewrites or treats specially. */
export function isPlainName(name: string, windows: boolean): boolean {
  if (name === '' || name === '.' || name === '..' || name.includes('\u0000')) return false
  if (!windows) return !name.includes('/')
  if (WINDOWS_BAD_CHARS.test(name) || /[\\/]/.test(name)) return false
  if (/[. ]$/.test(name)) return false
  return !WINDOWS_DEVICE.test(name)
}

/** Node's native realpath returns an extended-length (\\?\) prefix for some Windows paths. */
export const stripExtendedPrefix = stripPrefix

const hostWindows = () => process.platform === 'win32'

/** realpath: every symlink and `..` resolved against the real disk, or null. */
export function canonical(path: string): string | null {
  try {
    return stripExtendedPrefix(realpathSync.native(path))
  } catch {
    return null
  }
}

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const isFilesystemRoot = (path: string, windows: boolean): boolean => {
  const { names } = splitPath(path, windows)
  if (windows && /^\\\\/.test(path.replace(/\//g, '\\'))) return false // a UNC share may be a library
  return names.length === 0
}

export class PathSandbox {
  readonly roots: string[]
  readonly files: string[]
  private readonly windows: boolean
  /** The roots as given (resolved, not realpath'd), for the lexical network check. */
  private readonly spelledRoots: string[] = []

  constructor(roots: string[], options: SandboxOptions = {}) {
    this.windows = options.windows ?? hostWindows()
    const windows = this.windows
    const home = options.home ?? os.homedir()
    const homeKey = fold(canonical(home) ?? home, windows)
    const seen = new Set<string>()
    this.roots = []
    for (const root of roots) {
      if (!isAbsolutePath(root, windows)) continue
      const real = canonical(root)
      if (!real || !isDirectory(real)) continue
      const key = fold(real, windows)
      if (isFilesystemRoot(real, windows) || key === homeKey || seen.has(key)) continue
      seen.add(key)
      this.roots.push(real)
      this.spelledRoots.push(this.pathApi().resolve(root))
    }
    this.files = (options.files ?? []).filter((file) => isAbsolutePath(file, windows))
  }

  /** The resolved path the agent may use, or why not. The file itself need
      not exist (a write may create it), but its folder must. */
  resolve(path: string): Resolution {
    const windows = this.windows
    if (!isAbsolutePath(path, windows)) return { ok: false, denial: 'notAbsolute' }
    const standard = windows ? nodePath.win32.normalize(path) : nodePath.posix.normalize(path)
    const file = this.files.find((entry) => fold(this.normalizeFile(entry), windows) === fold(standard, windows))
    if (file) return { ok: true, path: file }
    /* LEXICAL, before any fs call: realpath of a UNC path such as \\attacker\share would
       already hand that server the user's NTLM hash. A network path is
       considered only inside a root that is itself on that share. */
    if (isNetworkPath(standard, this.pathApi()) && !networkAllowed(standard, [...this.spelledRoots, ...this.roots], this.pathApi())) {
      return { ok: false, denial: 'outside' }
    }

    let resolved = canonical(path)
    if (!resolved) {
      // A dangling symlink points somewhere we cannot check.
      try {
        if (lstatSync(path).isSymbolicLink()) return { ok: false, denial: 'outside' }
      } catch {
        /* does not exist at all: a new file, perhaps */
      }
      const parts = splitPath(standard, windows)
      const name = parts.names[parts.names.length - 1] ?? ''
      if (!isPlainName(name, windows)) return { ok: false, denial: 'invalidName' }
      const folder = canonical(windows ? nodePath.win32.dirname(standard) : nodePath.posix.dirname(standard))
      if (!folder || !isDirectory(folder)) return { ok: false, denial: 'missingFolder' }
      resolved = (windows ? nodePath.win32 : nodePath.posix).join(folder, name)
    }

    for (const root of this.roots) {
      if (!isBelow(root, resolved, windows)) continue
      const below = namesBelow(root, resolved, windows)
      if (below.some(isHiddenName)) return { ok: false, denial: 'hidden' }
      if (windows && below.some((name) => !isPlainName(name, true))) return { ok: false, denial: 'invalidName' }
      return { ok: true, path: resolved }
    }
    return { ok: false, denial: 'outside' }
  }

  allows(path: string): boolean {
    return this.resolve(path).ok
  }

  private pathApi() {
    return this.windows ? nodePath.win32 : nodePath.posix
  }

  private normalizeFile(file: string): string {
    return this.windows ? nodePath.win32.normalize(file) : nodePath.posix.normalize(file)
  }
}
