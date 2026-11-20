import nodePath from 'node:path'

/* Lexical path rules: pure string work, never a file system call. Every main
   handler that receives a path from the renderer (or from an agent) runs these
   FIRST, because on Windows merely touching `\\server\share\x` — a realpath, a
   stat, an open — makes the OS connect to that server over SMB or WebDAV and
   offer the user's NTLM credentials. A network path is therefore refused here,
   before any fs call, unless it lies lexically inside a root that is itself on
   that network share (one the user chose). No Electron imports; unit tested. */

export type PathFlavour = Pick<typeof nodePath, 'resolve' | 'dirname' | 'isAbsolute' | 'sep' | 'relative' | 'normalize' | 'parse'>

const isWindowsFlavour = (pathApi: PathFlavour) => pathApi.sep === '\\'

/** `\\?\…` and `\\.\…`: Win32 device / extended-length paths. Never accepted
    from the renderer or an agent; main produces plain paths itself. */
export function isDevicePath(value: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(value)
}

/* Drive letters mapped to network shares (`net use`), kept current by
   networkDrives.ts. A path on one is a network path just like its UNC form:
   touching it reaches the server. */
let mappedDrives: ReadonlySet<string> = new Set()

export function setNetworkDrives(letters: Iterable<string>): void {
  mappedDrives = new Set([...letters].map((letter) => letter.toUpperCase()))
}

/** A UNC path (`\\server\share\…`, either separator), a device path, or a
    path on a drive letter mapped to a network share. Only meaningful on
    Windows; on POSIX `//x` is an ordinary absolute path. */
export function isNetworkPath(value: string, pathApi: PathFlavour = nodePath): boolean {
  if (!isWindowsFlavour(pathApi)) return false
  if (/^[\\/]{2}/.test(value)) return true
  const drive = /^([A-Za-z]):/.exec(value)
  return Boolean(drive && mappedDrives.has(drive[1].toUpperCase()))
}

/** Node's native realpath returns `\\?\C:\x` or `\\?\UNC\srv\x` for some paths. */
export function stripExtendedPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return '\\\\' + value.slice(8)
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return value.slice(4)
  return value
}

/** `\\server\share` (lower-cased) for a UNC path, else null. */
export function uncShareRoot(value: string): string | null {
  if (isDevicePath(value)) return null
  const match = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(value)
  return match ? `\\\\${match[1]}\\${match[2]}`.toLowerCase() : null
}

/** The comparison key: resolved, and case-folded on Windows. */
export function pathKey(value: string, pathApi: PathFlavour = nodePath): string {
  const resolved = pathApi.resolve(value)
  return isWindowsFlavour(pathApi) ? resolved.toLowerCase() : resolved
}

/** A path main can reason about at all: a string, absolute, no NUL, and on
    Windows not a device path and not drive-relative (`C:x`). Lexical only. */
export function isPlainAbsolute(value: unknown, pathApi: PathFlavour = nodePath): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 32_767) return false
  if (!pathApi.isAbsolute(value)) return false
  if (isWindowsFlavour(pathApi)) {
    if (isDevicePath(value)) return false
    if (/^[A-Za-z]:(?![\\/])/.test(value)) return false
    /* `\foo` is "absolute" to Node but relative to the current drive. */
    if (/^[\\/](?![\\/])/.test(value)) return false
  }
  return true
}

/** True when `child` is `root` itself or below it, compared lexically
    (resolved, case-insensitive on Windows). */
export function isLexicallyInside(child: string, root: string, pathApi: PathFlavour = nodePath): boolean {
  const childKey = pathKey(child, pathApi)
  const rootKey = pathKey(root, pathApi)
  if (childKey === rootKey) return true
  const sep = pathApi.sep
  return childKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)
}

/** Whether a network `target` is acceptable: only when it lies lexically
    inside one of `roots` that is itself on a network share. Local targets
    always pass this check (other rules decide them). */
export function networkAllowed(target: string, roots: readonly string[], pathApi: PathFlavour = nodePath): boolean {
  if (!isNetworkPath(target, pathApi)) return true
  if (isDevicePath(target)) return false
  return roots.some((root) => isNetworkPath(root, pathApi) && !isDevicePath(root) && isLexicallyInside(target, root, pathApi))
}

/** A drive or filesystem root: `C:\`, `/`, or a bare `\\server\share`. */
export function isFilesystemRootPath(value: string, pathApi: PathFlavour = nodePath): boolean {
  const resolved = pathApi.resolve(value)
  return pathApi.dirname(resolved) === resolved
}

/** Why `folder` is too broad to be a library folder, or null when it is fine.
    Mac's sandbox refuses the home folder and `/`; Windows also refuses every
    drive root and any folder that holds the home folder (`C:\Users`), since
    adding one would hand the whole profile to the reader and the agent. A UNC
    share root (`\\nas\notes`) is a legitimate library. */
export function broadFolderReason(folder: string, home: string, pathApi: PathFlavour = nodePath): string | null {
  const resolved = pathApi.resolve(folder)
  if (isFilesystemRootPath(resolved, pathApi) && !(isWindowsFlavour(pathApi) && (uncShareRoot(resolved) || isNetworkPath(resolved, pathApi)))) {
    return 'A whole drive is too broad for the library. Choose a folder of notes instead'
  }
  if (home && pathApi.isAbsolute(home)) {
    if (pathKey(resolved, pathApi) === pathKey(home, pathApi)) {
      return 'Your whole home folder is too broad for the library. Choose a folder of notes instead'
    }
    if (isLexicallyInside(home, resolved, pathApi)) {
      return 'That folder holds your home folder, which is too broad for the library. Choose a folder of notes instead'
    }
  }
  return null
}
