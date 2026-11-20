/* Pure helpers for the updater: version parsing, release/asset selection, URL
   allow-listing, checksum parsing and signature comparison. No Electron and no
   I/O, so update.test.ts can exercise all of it. Owned by the updater
   workstream (D). The Mac counterpart is InkwellCore/Update.swift. */

export const REPO_OWNER = 'mrelph'
export const REPO_NAME = 'InkwellWindows'
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
export const RELEASES_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`
export const RELEASE_TAG_PAGE = `${RELEASES_PAGE}/tag/`

/** github.com serves the asset link and redirects to one of the others. */
export const ASSET_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

export type Version = [number, number, number]
export type InstallerArch = 'x64' | 'arm64'

/* Deliberately strict: a prerelease or build suffix is not something to nag
   anyone about, and an unparseable tag is not a version at all. */
export const parseVersion = (raw: unknown): Version | null => {
  if (typeof raw !== 'string') return null
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(raw.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export const compareVersions = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

export const toInstallerArch = (arch: string): InstallerArch | null =>
  arch === 'x64' || arch === 'arm64' ? arch : null

/** The installer's file name for a version and arch (matches `nsis.artifactName`). */
export const installerName = (version: string, arch: InstallerArch) => `Inkwell-Setup-${version}-${arch}.exe`

/** Plain HTTPS on the default port, no credentials, no `..` segments. */
const isPlainHttps = (url: URL) =>
  url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') &&
  !url.pathname.split('/').includes('..')

const parseUrl = (raw: unknown): URL | null => {
  if (typeof raw !== 'string') return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** A URL taken from the API response that a download may start from. It must
    be a github.com link inside this repo's release downloads. */
export function isAllowedAssetUrl(raw: unknown): boolean {
  const url = parseUrl(raw)
  if (!url || !isPlainHttps(url) || url.hostname !== 'github.com') return false
  return url.pathname.startsWith(`/${REPO_OWNER}/${REPO_NAME}/releases/download/`)
}

/** Any hop of a download, including redirects and the final response URL. */
export function isAllowedDownloadHost(raw: unknown): boolean {
  const url = parseUrl(raw)
  return Boolean(url && isPlainHttps(url) && ASSET_HOSTS.has(url.hostname.toLowerCase()))
}

/** At most this many redirects per download (GitHub uses one). */
export const MAX_REDIRECTS = 5

export type RedirectDecision = { ok: true; url: string } | { ok: false; message: string }

/** Whether the download may follow a redirect from `current` to `location`
    (relative locations resolve against `current`), as hop number `hop`
    (1-based). Every hop must be plain HTTPS on one of GitHub's asset hosts. */
export function checkRedirect(current: string, location: unknown, hop: number): RedirectDecision {
  if (hop > MAX_REDIRECTS) return { ok: false, message: 'The download was redirected too many times and was stopped.' }
  if (typeof location !== 'string' || !location) return { ok: false, message: 'The download was redirected somewhere untrusted and was stopped.' }
  let next: string
  try {
    next = new URL(location, current).toString()
  } catch {
    return { ok: false, message: 'The download was redirected somewhere untrusted and was stopped.' }
  }
  return isAllowedDownloadHost(next)
    ? { ok: true, url: next }
    : { ok: false, message: 'The download was redirected somewhere untrusted and was stopped.' }
}

export type ReleaseInfo = {
  /** `x.y.z` */
  version: string
  /** The tag verbatim, `vX.Y.Z`. */
  tag: string
  /** Installer + checksum for this arch, when the release carries both. */
  installerUrl?: string
  sha256Url?: string
}

/** Picks the release out of a `/releases/latest` payload: exact `vX.Y.Z`, not a
    prerelease, not a draft. Returns null for anything else. Assets for `arch`
    are attached only when both the installer and its `.sha256` are present
    under allow-listed URLs. */
export function selectRelease(payload: unknown, arch: InstallerArch | null): ReleaseInfo | null {
  if (typeof payload !== 'object' || payload === null) return null
  const release = payload as Record<string, unknown>
  if (release.draft === true || release.prerelease === true) return null
  const tag = release.tag_name
  if (typeof tag !== 'string' || !/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag)) return null
  const parsed = parseVersion(tag)
  if (!parsed) return null
  const version = parsed.join('.')

  const info: ReleaseInfo = { version, tag }
  if (!arch || !Array.isArray(release.assets)) return info

  const wanted = installerName(version, arch)
  const urlFor = (name: string): string | undefined => {
    for (const asset of release.assets as unknown[]) {
      if (typeof asset !== 'object' || asset === null) continue
      const entry = asset as Record<string, unknown>
      if (entry.name === name && isAllowedAssetUrl(entry.browser_download_url)) {
        return String(entry.browser_download_url)
      }
    }
    return undefined
  }
  const installerUrl = urlFor(wanted)
  const sha256Url = urlFor(`${wanted}.sha256`)
  if (installerUrl && sha256Url) {
    info.installerUrl = installerUrl
    info.sha256Url = sha256Url
  }
  return info
}

/** Reads a `.sha256` file: `<hex>`, `<hex>  <name>` or `<hex> *<name>`, with an
    optional BOM and CRLF. When the file names a file it must be `expectedName`.
    Returns lower-case hex, or null if the text is not a usable checksum. */
export function parseSha256(text: string, expectedName?: string): string | null {
  const line = text.replace(/^﻿/, '').split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line) return null
  const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line)
  if (!match) return null
  const named = match[2]?.trim()
  if (named && expectedName) {
    const base = named.split(/[\\/]/).pop()
    if (base !== expectedName) return null
  }
  return match[1].toLowerCase()
}

export type SignatureInfo = {
  /** Authenticode status as PowerShell reports it: Valid, NotSigned, HashMismatch… */
  status: string
  /** The signer certificate's subject, empty when unsigned. */
  subject: string
}

/** Decodes the JSON the PowerShell probe prints. Null when it is not usable. */
export function parseSignatureJson(text: string): SignatureInfo | null {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>
    if (typeof value?.status !== 'string') return null
    return { status: value.status, subject: typeof value.subject === 'string' ? value.subject : '' }
  } catch {
    return null
  }
}

export type SignatureVerdict = { ok: true; enforced: boolean } | { ok: false; message: string }

/** The running app being signed means the installer must be signed by the same
    publisher. Only an app the probe DEFINITIVELY reported as unsigned
    (`NotSigned`, today's state) skips the signature check — the checksum is
    never skipped. `app` null means the probe of the running exe failed
    (PowerShell blocked, a timeout, unreadable output): with `requireProbe`
    (a packaged build on Windows) that refuses the install rather than
    failing open; without it (dev, other platforms) there is no Authenticode
    to compare. Any other unsigned status (`UnknownError`, `HashMismatch`…)
    refuses too. */
export function evaluateSignatures(
  app: SignatureInfo | null,
  installer: SignatureInfo | null,
  options: { requireProbe?: boolean } = {}
): SignatureVerdict {
  if (!app) {
    return options.requireProbe
      ? { ok: false, message: 'Inkwell could not check its own signature (Windows PowerShell did not answer), so the update was not installed. Try again, or download it from the release page.' }
      : { ok: true, enforced: false }
  }
  if (!app.subject) {
    return app.status === 'NotSigned'
      ? { ok: true, enforced: false }
      : { ok: false, message: `Inkwell could not read its own signature (${app.status.slice(0, 40)}), so the update was not installed.` }
  }
  if (!installer || installer.status !== 'Valid') {
    return { ok: false, message: 'The update is not signed by Inkwell’s publisher, so it was not installed.' }
  }
  if (installer.subject.trim().toLowerCase() !== app.subject.trim().toLowerCase()) {
    return { ok: false, message: 'The update is signed by a different publisher than this copy of Inkwell, so it was not installed.' }
  }
  return { ok: true, enforced: true }
}
