import { protocol } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import { ASSET_SCHEME } from './ipc/contract'
import { authorizeAsset, parseAssetUrl } from './assetGuard'
import { refreshNetworkDrives } from './networkDrives'
import { isTrustedNoteFolder, libraryFolders } from './trustedDocuments'

/* Note images (PARITY D1/D2). A custom scheme replaces file:// image loads,
   so relative, `file:`, absolute and `~` paths resolve against the note
   rather than the app bundle, and the CSP can forbid every remote image.

   URL layout: inkwell-asset://local/?f=<path>&r=<note folder>
   Policy (assetGuard.ts): image types only, any LOCAL image (as on the Mac);
   network paths only inside a library folder or a trusted note folder on that
   share, refused lexically before any fs call; real path re-checked; 40 MB
   cap; nosniff and a locked-down response CSP. The library folders come from
   main's own in-memory record (trustedDocuments.ts), which the Add Folder
   dialog updates the moment it returns — not from library.json, which the
   renderer saves on a debounce.
   registerAssetSchemes() runs before app ready, registerAssetProtocol() after. */

const MAX_BYTES = 40 * 1024 * 1024

export function registerAssetSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

const plain = (status: number) => new Response(null, { status, headers: { 'X-Content-Type-Options': 'nosniff' } })

let registered = false

export function registerAssetProtocol(): void {
  if (registered) return
  registered = true
  protocol.handle(ASSET_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405)
    const parsed = parseAssetUrl(request.url)
    if (!parsed) return plain(400)

    refreshNetworkDrives()
    const verdict = await authorizeAsset(parsed, libraryFolders(), {
      home: os.homedir(),
      realpath,
      isTrustedRoot: (folder) => isTrustedNoteFolder(folder)
    })
    if (!verdict.ok) return plain(verdict.reason === 'not found' ? 404 : 403)

    try {
      const info = await stat(verdict.file)
      if (!info.isFile() || info.size > MAX_BYTES) return plain(info.isFile() ? 413 : 404)
      /* Validators from mtime + size: the browser cache keys on the URL (path),
         so an edited image revalidates and a 304 saves the read. */
      const etag = `"${Math.round(info.mtimeMs)}-${info.size}"`
      const headers: Record<string, string> = {
        'Content-Type': verdict.type,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        ETag: etag,
        'Last-Modified': info.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      }
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(new Uint8Array(await readFile(verdict.file)), { status: 200, headers })
    } catch {
      return plain(404)
    }
  })
}
