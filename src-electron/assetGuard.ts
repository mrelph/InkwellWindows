import nodePath from 'node:path'
import { isFilesystemRootPath, isLexicallyInside, isNetworkPath, isPlainAbsolute, networkAllowed, stripExtendedPrefix } from './pathRules'

/* Pure(ish) authorisation for the asset scheme. No Electron imports, so it is
   unit tested with an injected path flavour and realpath.

   Policy (matches the Mac's Paths.resolveImage): any image on a LOCAL drive
   loads — relative paths with `../`, absolute paths and `~` included. What
   keeps that safe against a compromised renderer is the page itself: the CSP
   allows images only from 'self' and this scheme and `connect-src 'self'`, so
   a page that reads a local image has no channel to send it anywhere.

   What stays refused:
   - anything that is not an image type (by extension, before and after the
     real path is resolved), and anything over the size cap (assets.ts);
   - NETWORK paths — UNC (`\\server\share\…`), device paths (`\\?\`, `\\.\`)
     and drive letters mapped to a share — unless they lie inside a library
     folder or the folder of a note main itself opened that is on the same
     share. This check is LEXICAL and runs before any fs call: on Windows a
     realpath of `\\attacker\share\x.png` already sends the user's NTLM hash.
   - a local path whose real path turns out to be on a network share (a
     mapped drive `net use` has not reported yet, a junction to a share),
     under the same rule, now by real path.

   The renderer names the note's folder in `r`; it counts only when
   `isTrustedRoot` says main itself handled a document there
   (trustedDocuments.ts), and only for network images. */

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

export type PathApi = typeof nodePath.win32 | typeof nodePath.posix | typeof nodePath

export type AssetRequest = { file: string; root?: string }

/** Parses `inkwell-asset://local/?f=<path>&r=<note folder>`. Null when malformed. */
export function parseAssetUrl(raw: string): AssetRequest | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const file = url.searchParams.get('f')
  if (!file) return null
  const root = url.searchParams.get('r') ?? undefined
  return { file, root: root || undefined }
}

export const imageMimeType = (file: string, pathApi: PathApi = nodePath): string | null =>
  IMAGE_TYPES[pathApi.extname(file).toLowerCase()] ?? null

export function isInside(target: string, root: string, pathApi: PathApi = nodePath): boolean {
  const rel = pathApi.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !pathApi.isAbsolute(rel)
}

export type AuthorizeDeps = {
  pathApi?: PathApi
  home: string
  realpath: (path: string) => Promise<string>
  /** True only for the parent folder of a document main itself handled. */
  isTrustedRoot: (folder: string) => boolean
}

export type AuthorizeResult = { ok: true; file: string; type: string } | { ok: false; reason: string }

const expandHome = (value: string, home: string) =>
  value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? home + value.slice(1) : value

export async function authorizeAsset(
  request: AssetRequest,
  libraryFolders: readonly string[],
  deps: AuthorizeDeps
): Promise<AuthorizeResult> {
  const pathApi = deps.pathApi ?? nodePath
  const refuse = (reason: string): AuthorizeResult => ({ ok: false, reason })

  if (request.file.includes('\0') || (request.root ?? '').includes('\0')) return refuse('invalid path')
  const expanded = expandHome(request.file, deps.home)
  /* A relative path here means the renderer failed to anchor it: refuse rather
     than resolve against the process working directory. Device paths and
     drive-relative paths are refused too. */
  if (!isPlainAbsolute(expanded, pathApi)) return refuse('not absolute')
  const resolved = pathApi.resolve(expanded)
  if (!imageMimeType(resolved, pathApi)) return refuse('not an image type')

  /* The folders a network image may come from: the library, and the note's
     folder when main vouches for it. A drive/filesystem root never counts. */
  const networkRoots: string[] = []
  for (const folder of libraryFolders) if (isPlainAbsolute(folder, pathApi)) networkRoots.push(pathApi.resolve(folder))
  if (request.root) {
    const root = expandHome(request.root, deps.home)
    if (isPlainAbsolute(root, pathApi) && !isFilesystemRootPath(root, pathApi) && deps.isTrustedRoot(pathApi.resolve(root))) {
      networkRoots.push(pathApi.resolve(root))
    }
  }

  /* LEXICAL, before any fs call. */
  if (isNetworkPath(resolved, pathApi) && !networkAllowed(resolved, networkRoots, pathApi)) return refuse('network path')

  let real: string
  try {
    real = stripExtendedPrefix(await deps.realpath(resolved))
  } catch {
    return refuse('not found')
  }
  const type = imageMimeType(real, pathApi)
  if (!type) return refuse('not an image type')

  /* A local spelling that really lives on a share (a mapped drive not yet
     known, a junction to a share): the same rule, by real path. */
  if (isNetworkPath(real, pathApi)) {
    for (const root of networkRoots) {
      /* Only a trusted root that holds the request lexically is realpath'd. */
      if (!isLexicallyInside(resolved, root, pathApi)) continue
      let realRoot: string
      try {
        realRoot = stripExtendedPrefix(await deps.realpath(root))
      } catch {
        continue
      }
      if (isInside(real, realRoot, pathApi)) return { ok: true, file: real, type }
    }
    return refuse('network path')
  }
  return { ok: true, file: real, type }
}
