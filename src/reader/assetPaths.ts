/* Renderer-side image source resolution. DOM-free and Node-free so it is unit
   testable and cannot touch the disk: it only decides what an `![](src)` is and
   builds the asset-scheme URL. The policy is enforced in the main process
   (src-electron/assetGuard.ts), never trusted from here. Mirrors the Mac's
   Paths.resolveImage. Owned by the reader workstream (C). */

/** Must equal ASSET_SCHEME in src-electron/ipc/contract.ts (a test asserts it). */
export const ASSET_SCHEME_NAME = 'inkwell-asset'

export type ImageSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote' }
  /** A UNC, `file://server/…` or device path the note does not live on: never
      requested, because on Windows merely asking for one makes the OS offer
      the user's credentials to that server. */
  | { kind: 'network' }
  | { kind: 'blocked' }

const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const TWO_SLASHES = /^[\\/]{2}/
const DEVICE = /^[\\/]{2}[?.](?:[\\/]|$)/
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** `\\server\share` (lower-cased) of a UNC path; null for anything else,
    device paths (`\\?\`, `\\.\`) included. */
export const uncShare = (value: string): string | null => {
  if (DEVICE.test(value)) return null
  const match = UNC.exec(value)
  return match ? `\\\\${match[1]}\\${match[2]}`.toLowerCase() : null
}

/** Folder part of an absolute path, either separator. Empty when there is none. */
export const dirOf = (filePath: string) => {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (cut < 0) return ''
  if (cut === 0) return filePath.slice(0, 1)
  /* `C:\note.md` -> `C:\`, not `C:`. */
  if (cut === 2 && WINDOWS_DRIVE.test(filePath)) return filePath.slice(0, 3)
  return filePath.slice(0, cut)
}

const isAbsoluteLike = (value: string) =>
  WINDOWS_DRIVE.test(value) || value.startsWith('/') || value.startsWith('\\')
  || value === '~' || value.startsWith('~/') || value.startsWith('~\\')

const fromFileUrl = (raw: string): string | null => {
  /* file:///C:/a/b.png, file://server/share/a.png, file:///home/u/a.png */
  const rest = raw.replace(/^file:/i, '')
  if (!rest.startsWith('//')) return null
  const afterSlashes = rest.slice(2)
  const slash = afterSlashes.indexOf('/')
  const host = slash < 0 ? afterSlashes : afterSlashes.slice(0, slash)
  const pathPart = decode(slash < 0 ? '' : afterSlashes.slice(slash))
  if (host && host.toLowerCase() !== 'localhost') return `\\\\${host}${pathPart.replace(/\//g, '\\')}`
  /* `/C:/x` -> `C:/x` */
  return /^\/[a-zA-Z]:/.test(pathPart) ? pathPart.slice(1) : pathPart
}

/** A network path is requested only when the note lives on that same share
    (its relative images live there too, and opening the note already
    connected). Anything else written into a note — `\\attacker\share\x.png`,
    `file://attacker/x.png`, `\\?\…` — is never requested. */
const local = (candidate: string, notePath?: string): ImageSource => {
  if (!TWO_SLASHES.test(candidate)) return { kind: 'local', path: candidate }
  const share = uncShare(candidate)
  const noteShare = notePath ? uncShare(notePath) : null
  return share && noteShare && share === noteShare ? { kind: 'local', path: candidate } : { kind: 'network' }
}

/** Classifies an image source. `local.path` may still contain `..`, `~` or
    mixed separators; the main process normalises and checks it. */
export function resolveImageSource(src: string | undefined, notePath?: string): ImageSource {
  const raw = (src ?? '').trim()
  if (!raw || raw.includes('\0')) return { kind: 'blocked' }

  if (!WINDOWS_DRIVE.test(raw)) {
    const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase()
    if (scheme) {
      if (scheme === 'http' || scheme === 'https') return { kind: 'remote' }
      if (scheme === 'file') {
        const path = fromFileUrl(raw)
        return path ? local(path, notePath) : { kind: 'blocked' }
      }
      return { kind: 'blocked' }
    }
  }

  /* `//host/x.png` in Markdown is a protocol-relative web URL (Mac: remote);
     `\\host\x.png` is a UNC path. */
  if (raw.startsWith('//')) return { kind: 'remote' }

  const decoded = decode(raw)
  if (TWO_SLASHES.test(decoded)) return local(decoded, notePath)
  if (isAbsoluteLike(decoded)) return { kind: 'local', path: decoded }

  const dir = notePath ? dirOf(notePath) : ''
  if (!dir) return { kind: 'blocked' }
  const joiner = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'
  return local(`${dir}${joiner}${decoded}`, notePath)
}

/** The privileged-scheme URL for a local image. `root` is the note's folder
    (empty for drafts); the main process re-validates both. */
export function assetUrl(filePath: string, notePath?: string): string {
  const params = new URLSearchParams({ f: filePath })
  const root = notePath ? dirOf(notePath) : ''
  if (root) params.set('r', root)
  return `${ASSET_SCHEME_NAME}://local/?${params.toString()}`
}
