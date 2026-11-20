import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMarkdown } from './fileStore'
import { isNetworkPath, isPlainAbsolute, networkAllowed, type PathFlavour } from './pathRules'

/* Where a link in the reader points, decided by MAIN (Mac AppModel.openLink):
   a relative link or a `file:` URL to a Markdown file opens that note in
   Inkwell, resolved against the folder of the note it is in. `#anchors` and
   web links are the renderer's business and never reach here; anything else
   (a non-Markdown file, another scheme) does nothing. The renderer only
   passes the note it is showing and the raw href; main checks that note is
   one it vouched for, resolves the href itself and validates the result —
   lexically, before any fs call (pathRules.ts). No Electron imports. */

export type LinkResolution = { ok: true; path: string } | { ok: false; reason: 'invalid' | 'notMarkdown' | 'network' }

const MAX_HREF = 4096

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Resolves `href` from the note at `from` (absolute, already trusted by the
    caller). `networkRoots` are the library folders: a target on a network
    share is allowed only inside one, or on the share the note itself is on. */
export function resolveNoteLink(
  from: string,
  href: unknown,
  networkRoots: readonly string[],
  pathApi: PathFlavour = nodePath
): LinkResolution {
  if (typeof href !== 'string' || !href || href.length > MAX_HREF || href.includes('\0')) return { ok: false, reason: 'invalid' }
  if (!isPlainAbsolute(from, pathApi)) return { ok: false, reason: 'invalid' }
  const windows = pathApi.sep === '\\'
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return { ok: false, reason: 'invalid' }

  let target: string
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase()
  if (scheme && !(windows && scheme.length === 1)) {
    if (scheme !== 'file') return { ok: false, reason: 'invalid' }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    url.hash = ''
    url.search = ''
    if (url.host && url.host.toLowerCase() !== 'localhost') {
      /* file://server/share/x.md — a UNC path, spelled out without touching it. */
      if (!windows) return { ok: false, reason: 'network' }
      target = `\\\\${url.host}${decode(url.pathname).replace(/\//g, '\\')}`
    } else {
      url.host = ''
      try {
        target = fileURLToPath(url, { windows })
      } catch {
        return { ok: false, reason: 'invalid' }
      }
    }
  } else if (scheme) {
    /* `C:\x.md` / `C:/x.md` written as a link: an absolute path. */
    target = decode(raw.split('#')[0].split('?')[0])
  } else {
    const pathPart = decode(raw.split('#')[0].split('?')[0])
    if (!pathPart) return { ok: false, reason: 'invalid' }
    /* Mac appends the link to the note's folder, so `/x.md` means the same
       as `x.md`; a `//host` start would otherwise read as UNC. */
    target = pathApi.resolve(pathApi.dirname(pathApi.resolve(from)), pathPart.replace(/^[\\/]+/, ''))
  }

  if (!isPlainAbsolute(target, pathApi)) return { ok: false, reason: 'invalid' }
  target = pathApi.resolve(target)
  if (!isMarkdown(target)) return { ok: false, reason: 'notMarkdown' }
  if (isNetworkPath(target, pathApi)) {
    const roots = [...networkRoots]
    if (isNetworkPath(from, pathApi)) roots.push(pathApi.parse(pathApi.resolve(from)).root)
    if (!networkAllowed(target, roots, pathApi)) return { ok: false, reason: 'network' }
  }
  return { ok: true, path: target }
}
