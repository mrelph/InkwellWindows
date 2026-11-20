import { app, net } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateCheckResult, UpdateNotice } from './ipc/contract'
import { decodeDocument, writeAtomically } from './fileStore'
import { getSetting, setSetting } from './settings'
import {
  LATEST_RELEASE_URL,
  RELEASE_TAG_PAGE,
  compareVersions,
  isAllowedAssetUrl,
  parseVersion,
  selectRelease,
  toInstallerArch,
  type ReleaseInfo
} from './updateRelease'

/** What the renderer needs to draw the indicator, or null for "say nothing". */
export type { UpdateNotice } from './ipc/contract'

/* GitHub **Releases**, not tags. Inkwell for Windows publishes a Release per
   `vX.Y.Z` tag (see .github/workflows/release.yml) carrying
   `Inkwell-Setup-<ver>-<arch>.exe` and a `.sha256` for each, so
   `/releases/latest` (newest non-draft, non-prerelease) is the source of truth.
   The notice's URL is always built here from the validated tag; the renderer
   never supplies a URL to shell.openExternal.

   Silence is still the default for the *automatic* check: opted out, up to
   date, dismissed and unreachable all return null, and a failed check does not
   stamp `checkedAt`. The *manual* check (`checkNow`) always runs and always
   answers. */

const CHECK_EVERY = 24 * 60 * 60 * 1000
const TIMEOUT = 8000

type Cache = {
  /** Only ever set by a check that actually reached GitHub. */
  checkedAt: number
  /** Normalised `x.y.z` of the newest release seen. */
  version?: string
  /** The tag verbatim, because the URL has to match what GitHub has. */
  tag?: string
  /** Installer + checksum URLs for this machine's arch (allow-listed on load). */
  installerUrl?: string
  sha256Url?: string
  /** The version the user waved away; anything newer speaks up again. */
  dismissed?: string
}

/* The env var predates the menu toggle and still wins: on Linux the way to say
   "never do that" is a line in a shell profile or the .desktop entry.
   Documented in the README. */
const envDisabled = () => {
  const value = process.env.INKWELL_NO_UPDATE_CHECK
  return value === '1' || value === 'true'
}

/** "Check for Updates Automatically". On by default; the env var forces it off. */
export function getAutoCheck(): boolean {
  return !envDisabled() && getSetting('autoUpdateCheck')
}

export function setAutoCheck(on: boolean): boolean {
  setSetting('autoUpdateCheck', on === true)
  return getAutoCheck()
}

const disabled = () => !getAutoCheck()

const cacheFile = () => path.join(app.getPath('userData'), 'update.json')

let cache: Cache | null = null

/* Same posture as state.ts: this is a file the user can open and mangle, and
   nothing in it is worth failing over. Every field is re-validated. */
async function readCache(): Promise<Cache> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(decodeDocument(await readFile(cacheFile()))) as Record<string, unknown>
    const version = parseVersion(parsed?.version) ? String(parsed.version) : undefined
    const tag = typeof parsed?.tag === 'string' && /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(parsed.tag) ? parsed.tag : undefined
    const assetsOk = isAllowedAssetUrl(parsed?.installerUrl) && isAllowedAssetUrl(parsed?.sha256Url)
    cache = {
      checkedAt: typeof parsed?.checkedAt === 'number' ? parsed.checkedAt : 0,
      version,
      tag,
      installerUrl: assetsOk ? String(parsed.installerUrl) : undefined,
      sha256Url: assetsOk ? String(parsed.sha256Url) : undefined,
      dismissed: parseVersion(parsed?.dismissed) ? String(parsed.dismissed) : undefined
    }
  } catch {
    cache = { checkedAt: 0 }
  }
  return cache
}

async function writeCache(next: Cache): Promise<void> {
  cache = next
  try {
    await mkdir(path.dirname(cacheFile()), { recursive: true })
    await writeAtomically(cacheFile(), JSON.stringify(next, null, 2))
  } catch {
    /* Remembering the answer is a convenience; re-asking tomorrow is fine. */
  }
}

/** The notice for a cache entry when it is newer than the running app. */
const newerNotice = (state: Cache): UpdateNotice | null => {
  const latest = parseVersion(state.version)
  const running = parseVersion(app.getVersion())
  if (!latest || !running || !state.version) return null
  if (compareVersions(latest, running) <= 0) return null
  return { version: state.version, url: `${RELEASE_TAG_PAGE}${state.tag ?? `v${state.version}`}` }
}

/** Same, but silent about a version the user dismissed. */
const toNotice = (state: Cache): UpdateNotice | null => {
  const notice = newerNotice(state)
  if (!notice) return null
  const dismissed = parseVersion(state.dismissed)
  if (dismissed && compareVersions(parseVersion(notice.version)!, dismissed) <= 0) return null
  return notice
}

type FetchOutcome =
  | { ok: true; release: ReleaseInfo | null }
  | { ok: false; message: string }

/* Electron's net rather than node:https: it goes through Chromium's stack, so a
   system or PAC proxy is honoured without Inkwell reimplementing any of it. */
async function fetchLatestRelease(): Promise<FetchOutcome> {
  try {
    const response = await net.fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Inkwell/${app.getVersion()}`
      },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    /* No release published yet: GitHub was reached and the answer is "nothing". */
    if (response.status === 404) return { ok: true, release: null }
    if (response.status === 403 || response.status === 429) {
      return { ok: false, message: 'GitHub is limiting requests right now. Try again later.' }
    }
    if (!response.ok) return { ok: false, message: `GitHub answered ${response.status}.` }
    const payload: unknown = await response.json()
    return { ok: true, release: selectRelease(payload, toInstallerArch(process.arch)) }
  } catch {
    /* No network, no DNS, a captive portal, GitHub having a bad day: all one
       answer. Being offline is the normal case for a local-first app. */
    return { ok: false, message: 'Could not reach GitHub. Check your connection and try again.' }
  }
}

const withRelease = (state: Cache, release: ReleaseInfo | null): Cache => ({
  ...state,
  checkedAt: Date.now(),
  version: release?.version,
  tag: release?.tag,
  installerUrl: release?.installerUrl,
  sha256Url: release?.sha256Url
})

/** The last known answer, from cache only. Never touches the network. */
export async function knownUpdate(): Promise<UpdateNotice | null> {
  if (disabled()) return null
  return toNotice(await readCache())
}

/** The cached newer release regardless of the auto-check setting or a dismissal:
    what "Restart to update" acts on after a manual check. */
export async function pendingUpdate(): Promise<UpdateNotice | null> {
  return newerNotice(await readCache())
}

/** Installer + checksum URLs for `version`, from the cache, when it is that
    version and the release carried assets for this arch. */
export async function releaseAssetsFor(version: string): Promise<{ installerUrl: string; sha256Url: string } | null> {
  const state = await readCache()
  if (state.version !== version || !state.installerUrl || !state.sha256Url) return null
  return { installerUrl: state.installerUrl, sha256Url: state.sha256Url }
}

/**
 * Asks GitHub at most once a day. Resolves to null far more often than not —
 * up to date, opted out, dismissed, or unreachable — and never rejects.
 */
export async function checkForUpdate(): Promise<UpdateNotice | null> {
  if (disabled()) return null
  const state = await readCache()
  if (Date.now() - state.checkedAt < CHECK_EVERY) return toNotice(state)

  const outcome = await fetchLatestRelease()
  /* A failed check does not stamp `checkedAt`. Launching on a train would
     otherwise buy a day of silence on a machine that came back online a minute
     later; the cost of not stamping it is one more request next launch. */
  if (!outcome.ok) return toNotice(state)

  const next = withRelease(state, outcome.release)
  await writeCache(next)
  return toNotice(next)
}

/** Check for Updates…: ignores the schedule, the opt-out and a dismissal, and
    always answers. */
export async function checkNow(): Promise<UpdateCheckResult> {
  const state = await readCache()
  const outcome = await fetchLatestRelease()
  if (!outcome.ok) return { kind: 'failed', message: outcome.message }
  const next = withRelease(state, outcome.release)
  await writeCache(next)
  const notice = newerNotice(next)
  return notice ? { kind: 'available', notice } : { kind: 'upToDate', version: app.getVersion() }
}

/** Waves away this version. Anything newer than it speaks up again. */
export async function dismissUpdate(version: unknown): Promise<void> {
  if (!parseVersion(version)) return
  await writeCache({ ...(await readCache()), dismissed: String(version) })
}
