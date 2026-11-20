import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateNotice } from './ipc/contract'
import { releaseAssetsFor } from './update'
import {
  checkRedirect,
  evaluateSignatures,
  installerName,
  isAllowedAssetUrl,
  parseSha256,
  parseSignatureJson,
  toInstallerArch,
  type SignatureInfo
} from './updateRelease'

/* Download, verify and install an update, then relaunch — the Windows
   counterpart of InkwellMac's UpdateInstaller. Owned by the updater workstream
   (D).

   Trust model: URLs come only from the GitHub API response (validated in
   updateRelease.ts). Redirects are not followed blindly: each hop is seen
   before it is taken (`net.request`, redirect 'manual') and must be plain
   HTTPS on one of GitHub's asset hosts, at most MAX_REDIRECTS of them. The
   installer's SHA-256 must match the release's `.sha256` file — never
   skipped. If the running app is Authenticode-signed the installer must also
   be signed by the same publisher. Only a probe that DEFINITIVELY reports the
   running app as unsigned skips that; a probe that fails (PowerShell blocked,
   a timeout, bad output) refuses the install in a packaged build.

   Relaunch: electron-builder's NSIS template, run with `/S --updated
   --force-run`, installs silently, waits for the running Inkwell to exit
   (`--updated`), then starts the app again as the user (`--force-run`, honoured
   for silent assisted installers). The installer is per-machine, so it
   elevates through UAC. */

export type PreparedUpdate = {
  version: string
  /** The verified installer on disk, ready to run. */
  installerPath: string
  /** Lower-case hex SHA-256 it was verified against; re-checked before running. */
  sha256: string
}

export type DownloadProgress = (progress: number | null) => void

export class UpdateInstallError extends Error {}

const MAX_INSTALLER_BYTES = 600 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 4096
const STALL_MS = 30_000
const WORK_PREFIX = 'inkwell-update-'

const headers = () => ({ 'User-Agent': `Inkwell/${app.getVersion()}`, Accept: 'application/octet-stream' })

type Received = { status: number; headers: Record<string, string | string[]>; body: AsyncIterable<Buffer | string>; abort: () => void }

/** One GET with redirects under our control: every hop goes through
    checkRedirect before it is followed. */
function requestFollowingCheckedRedirects(url: string, signal: AbortSignal): Promise<Received> {
  return new Promise((resolve, reject) => {
    let hops = 0
    let current = url
    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    for (const [name, value] of Object.entries(headers())) request.setHeader(name, value)
    const fail = (error: Error) => {
      try {
        request.abort()
      } catch {
        /* already finished */
      }
      reject(error)
    }
    signal.addEventListener('abort', () => fail(new UpdateInstallError('The download stalled and was stopped.')), { once: true })
    request.on('redirect', (_status, _method, redirectUrl) => {
      hops += 1
      const decision = checkRedirect(current, redirectUrl, hops)
      if (!decision.ok) {
        fail(new UpdateInstallError(decision.message))
        return
      }
      current = decision.url
      request.followRedirect()
    })
    request.on('response', (response) => {
      resolve({
        status: response.statusCode,
        headers: response.headers,
        body: response as unknown as AsyncIterable<Buffer | string>,
        abort: () => {
          try {
            request.abort()
          } catch {
            /* already finished */
          }
        }
      })
    })
    request.on('error', (error) => reject(error))
    request.end()
  })
}

/** Streams `url` to memory or disk, aborting on a stall, a bad redirect hop or
    an oversize body. Exactly one of `sink` (file path) or the returned buffer. */
async function fetchAsset(
  url: string,
  limit: number,
  options: { toFile?: string; onProgress?: DownloadProgress } = {}
): Promise<Buffer | null> {
  if (!isAllowedAssetUrl(url)) throw new UpdateInstallError('The update address is not a trusted GitHub release link.')
  const controller = new AbortController()
  let stall: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), STALL_MS)
  }
  arm()
  try {
    const response = await requestFollowingCheckedRedirects(url, controller.signal)
    if (response.status < 200 || response.status >= 300) {
      response.abort()
      throw new UpdateInstallError(`The download failed (${response.status}).`)
    }
    const lengthHeader = response.headers['content-length']
    const total = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader) || 0
    if (total > limit) {
      response.abort()
      throw new UpdateInstallError('The download is larger than expected and was stopped.')
    }

    const sink = options.toFile ? createWriteStream(options.toFile, { flags: 'wx' }) : null
    const chunks: Buffer[] = []
    let received = 0
    let lastReported = -1
    const failed = new Promise<never>((_, reject) => sink?.on('error', reject))
    failed.catch(() => undefined)
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new UpdateInstallError('The download stalled and was stopped.')), { once: true }))
    aborted.catch(() => undefined)
    const iterator = response.body[Symbol.asyncIterator]()
    try {
      for (;;) {
        const { done, value } = await Promise.race([iterator.next(), failed, aborted])
        if (done) break
        arm()
        const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
        received += chunk.byteLength
        if (received > limit) throw new UpdateInstallError('The download is larger than expected and was stopped.')
        if (sink) {
          if (!sink.write(chunk)) await Promise.race([new Promise<void>((resolve) => sink.once('drain', resolve)), failed, aborted])
        } else {
          chunks.push(chunk)
        }
        if (options.onProgress) {
          const progress = total ? received / total : null
          const step = progress === null ? -1 : Math.floor(progress * 100)
          if (step !== lastReported) {
            lastReported = step
            options.onProgress(progress)
          }
        }
      }
      if (sink) {
        await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())))
      }
    } catch (error) {
      sink?.destroy()
      response.abort()
      throw error
    }
    if (total && received !== total && !sink) throw new UpdateInstallError('The download was cut short.')
    return sink ? null : Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof UpdateInstallError) throw error
    throw new UpdateInstallError(controller.signal.aborted ? 'The download stalled and was stopped.' : 'The download failed. Check your connection and try again.')
  } finally {
    clearTimeout(stall)
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const powershell = () =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/* The path travels in an environment variable and the script is a constant, so
   no file name can ever become PowerShell syntax. */
const SIGNATURE_SCRIPT =
  "$s = Get-AuthenticodeSignature -LiteralPath $env:INKWELL_PROBE_PATH; " +
  "$subject = ''; if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }; " +
  "[pscustomobject]@{ status = $s.Status.ToString(); subject = $subject } | ConvertTo-Json -Compress"

/** The file's Authenticode status, or null when the probe itself failed. */
function readSignature(file: string): Promise<SignatureInfo | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SIGNATURE_SCRIPT],
      { env: { ...process.env, INKWELL_PROBE_PATH: file }, timeout: 30_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseSignatureJson(String(stdout)))
    )
  })
}

/** Deletes work directories left by earlier attempts (best effort). */
async function sweepStale(): Promise<void> {
  try {
    const root = app.getPath('temp')
    for (const entry of await readdir(root)) {
      if (!entry.startsWith(WORK_PREFIX)) continue
      const full = path.join(root, entry)
      const details = await stat(full).catch(() => null)
      if (details && Date.now() - details.mtimeMs > 24 * 60 * 60 * 1000) await rm(full, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch {
    /* housekeeping only */
  }
}

/** Downloads the installer for `notice`, verifies its checksum (and signature),
    and resolves with the verified file. Reports progress 0..1 (null = unknown). */
export async function downloadAndVerify(notice: UpdateNotice, onProgress: DownloadProgress): Promise<PreparedUpdate> {
  const arch = toInstallerArch(process.arch)
  const assets = await releaseAssetsFor(notice.version)
  if (!arch || !assets) throw new UpdateInstallError('This release has no installer for this PC.')
  const name = installerName(notice.version, arch)

  void sweepStale()
  const workDir = await mkdtemp(path.join(app.getPath('temp'), WORK_PREFIX))
  const installerPath = path.join(workDir, name)
  try {
    const checksumBytes = await fetchAsset(assets.sha256Url, MAX_CHECKSUM_BYTES)
    const expected = parseSha256(checksumBytes?.toString('utf8') ?? '', name)
    if (!expected) throw new UpdateInstallError('The release’s checksum file is not usable.')

    onProgress(0)
    await fetchAsset(assets.installerUrl, MAX_INSTALLER_BYTES, { toFile: installerPath, onProgress })

    const actual = await sha256File(installerPath)
    if (actual !== expected) throw new UpdateInstallError('The download did not match its checksum and was discarded.')

    /* A packaged Windows build must be able to read its own signature: a failed
       probe refuses the install instead of skipping the check. */
    const requireProbe = app.isPackaged && process.platform === 'win32'
    const appSignature = requireProbe ? await readSignature(process.execPath) : null
    const verdict = evaluateSignatures(appSignature, appSignature?.subject ? await readSignature(installerPath) : null, { requireProbe })
    if (!verdict.ok) throw new UpdateInstallError(verdict.message)

    return { version: notice.version, installerPath, sha256: actual }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    throw error instanceof UpdateInstallError ? error : new UpdateInstallError('The update could not be downloaded.')
  }
}

const INSTALLER_ARGS = ['/S', '--updated', '--force-run']

/* Node cannot start a requireAdministrator executable from a non-elevated
   process (it fails with EACCES / error 740), and the per-machine NSIS installer
   is one. Start-Process -Verb RunAs shows the UAC prompt; the command exits
   non-zero if the user declines, so we can tell before quitting. */
const ELEVATE_SCRIPT =
  "Start-Process -FilePath $env:INKWELL_INSTALLER -ArgumentList $env:INKWELL_INSTALLER_ARGS -Verb RunAs"

function launchElevated(installerPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ELEVATE_SCRIPT],
      {
        env: { ...process.env, INKWELL_INSTALLER: installerPath, INKWELL_INSTALLER_ARGS: INSTALLER_ARGS.join(' ') },
        timeout: 120_000,
        windowsHide: true
      },
      (error) => (error ? reject(new UpdateInstallError('The update was not started (administrator approval is required).')) : resolve())
    )
  })
}

function launchDirect(installerPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(installerPath, INSTALLER_ARGS, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Runs the verified installer and quits so it can replace the app, then the
    installer relaunches Inkwell. Must only be called after the unsaved-changes
    guard has passed. */
export async function installAndRelaunch(prepared: PreparedUpdate): Promise<void> {
  if (process.platform !== 'win32') throw new UpdateInstallError('Updates install on Windows only.')
  /* The file sat in a user-writable temp directory; confirm it is still the
     bytes that were verified before anything elevated runs it. */
  const again = await sha256File(prepared.installerPath).catch(() => null)
  if (again !== prepared.sha256) throw new UpdateInstallError('The downloaded update changed on disk and was not installed.')

  try {
    await launchDirect(prepared.installerPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EPERM' && !String((error as Error)?.message).includes('740')) {
      throw new UpdateInstallError('The installer could not be started.')
    }
    await launchElevated(prepared.installerPath)
  }
  app.quit()
}
