import { describe, expect, it } from 'vitest'
import {
  MAX_REDIRECTS,
  checkRedirect,
  compareVersions,
  evaluateSignatures,
  installerName,
  isAllowedAssetUrl,
  isAllowedDownloadHost,
  parseSha256,
  parseSignatureJson,
  parseVersion,
  selectRelease,
  toInstallerArch
} from './updateRelease'

const base = 'https://github.com/mrelph/InkwellWindows/releases/download'
const assetsFor = (version: string, arches: string[]) =>
  arches.flatMap((arch) => {
    const name = `Inkwell-Setup-${version}-${arch}.exe`
    return [
      { name, browser_download_url: `${base}/v${version}/${name}` },
      { name: `${name}.sha256`, browser_download_url: `${base}/v${version}/${name}.sha256` }
    ]
  })
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.2.3', draft: false, prerelease: false, assets: assetsFor('1.2.3', ['x64', 'arm64']), ...over
})

describe('versions', () => {
  it('parses strict x.y.z only', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    for (const bad of ['1.2', '1.2.3-beta', 'v1.2.3.4', 'latest', '', 'v1.2.x', null, 4, '1234567.0.0']) {
      expect(parseVersion(bad)).toBeNull()
    }
  })
  it('compares numerically, not lexically', () => {
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0)
    expect(compareVersions([0, 1, 4], [0, 1, 4])).toBe(0)
    expect(compareVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0)
  })
})

describe('selectRelease', () => {
  it('picks the installer and checksum for the arch', () => {
    const x64 = selectRelease(release(), 'x64')!
    expect(x64.version).toBe('1.2.3')
    expect(x64.installerUrl).toBe(`${base}/v1.2.3/Inkwell-Setup-1.2.3-x64.exe`)
    expect(x64.sha256Url).toBe(`${base}/v1.2.3/Inkwell-Setup-1.2.3-x64.exe.sha256`)
    expect(selectRelease(release(), 'arm64')!.installerUrl).toContain('arm64.exe')
  })
  it('rejects drafts, prereleases and non-exact tags', () => {
    expect(selectRelease(release({ draft: true }), 'x64')).toBeNull()
    expect(selectRelease(release({ prerelease: true }), 'x64')).toBeNull()
    expect(selectRelease(release({ tag_name: 'v1.2.3-rc1' }), 'x64')).toBeNull()
    expect(selectRelease(release({ tag_name: '1.2.3' }), 'x64')).toBeNull()
    expect(selectRelease(null, 'x64')).toBeNull()
  })
  it('still reports the release but omits assets when one is missing or untrusted', () => {
    const onlyArm = selectRelease(release({ assets: assetsFor('1.2.3', ['arm64']) }), 'x64')!
    expect(onlyArm.version).toBe('1.2.3')
    expect(onlyArm.installerUrl).toBeUndefined()
    const evil = assetsFor('1.2.3', ['x64']).map((a) => ({ ...a, browser_download_url: 'https://evil.example/x.exe' }))
    expect(selectRelease(release({ assets: evil }), 'x64')!.installerUrl).toBeUndefined()
    const noSum = assetsFor('1.2.3', ['x64']).slice(0, 1)
    expect(selectRelease(release({ assets: noSum }), 'x64')!.sha256Url).toBeUndefined()
  })
  it('maps process.arch and names installers', () => {
    expect(toInstallerArch('x64')).toBe('x64')
    expect(toInstallerArch('arm64')).toBe('arm64')
    expect(toInstallerArch('ia32')).toBeNull()
    expect(installerName('0.2.0', 'arm64')).toBe('Inkwell-Setup-0.2.0-arm64.exe')
  })
})

describe('URL allow-listing', () => {
  it('accepts only this repo’s github.com release downloads from the API', () => {
    expect(isAllowedAssetUrl(`${base}/v1.0.0/a.exe`)).toBe(true)
    for (const bad of [
      'http://github.com/mrelph/InkwellWindows/releases/download/v1/a.exe',
      'https://github.com/other/repo/releases/download/v1/a.exe',
      'https://github.com.evil.com/mrelph/InkwellWindows/releases/download/v1/a.exe',
      'https://user:pw@github.com/mrelph/InkwellWindows/releases/download/v1/a.exe',
      'https://github.com:8443/mrelph/InkwellWindows/releases/download/v1/a.exe',
      'https://objects.githubusercontent.com/a.exe',
      'file:///C:/a.exe', 'not a url', undefined
    ]) expect(isAllowedAssetUrl(bad)).toBe(false)
  })
  it('allows GitHub’s asset hosts for redirect hops only over https', () => {
    expect(isAllowedDownloadHost('https://objects.githubusercontent.com/x')).toBe(true)
    expect(isAllowedDownloadHost('https://release-assets.githubusercontent.com/x')).toBe(true)
    expect(isAllowedDownloadHost('https://github.com/x')).toBe(true)
    expect(isAllowedDownloadHost('http://objects.githubusercontent.com/x')).toBe(false)
    expect(isAllowedDownloadHost('https://evilgithubusercontent.com/x')).toBe(false)
    expect(isAllowedDownloadHost('https://api.github.com/x')).toBe(false)
  })
})

describe('parseSha256', () => {
  const hex = 'AB'.repeat(32)
  it('reads bare, sha256sum and BOM/CRLF forms, lower-casing the hash', () => {
    const lower = hex.toLowerCase()
    expect(parseSha256(hex)).toBe(lower)
    expect(parseSha256(`${hex}  a.exe\n`, 'a.exe')).toBe(lower)
    expect(parseSha256(`\uFEFF${hex} *a.exe\r\n`, 'a.exe')).toBe(lower)
  })
  it('rejects bad hashes and a checksum for a different file', () => {
    expect(parseSha256('')).toBeNull()
    expect(parseSha256('abc123')).toBeNull()
    expect(parseSha256(`${hex}0`)).toBeNull()
    expect(parseSha256(`${hex}  other.exe`, 'a.exe')).toBeNull()
    expect(parseSha256(`${'zz'.repeat(32)}  a.exe`, 'a.exe')).toBeNull()
  })
})

describe('signatures', () => {
  const signed = { status: 'Valid', subject: 'CN=Mark Relph' }
  it('skips the check for an unsigned or unknown app', () => {
    expect(evaluateSignatures(null, null)).toEqual({ ok: true, enforced: false })
    expect(evaluateSignatures({ status: 'NotSigned', subject: '' }, null)).toEqual({ ok: true, enforced: false })
  })
  it('requires the same publisher when the app is signed', () => {
    expect(evaluateSignatures(signed, { ...signed })).toEqual({ ok: true, enforced: true })
    expect(evaluateSignatures(signed, { status: 'Valid', subject: 'cn=mark relph ' })).toEqual({ ok: true, enforced: true })
    expect(evaluateSignatures(signed, { status: 'Valid', subject: 'CN=Someone Else' }).ok).toBe(false)
    expect(evaluateSignatures(signed, { status: 'NotSigned', subject: '' }).ok).toBe(false)
    expect(evaluateSignatures(signed, { status: 'HashMismatch', subject: signed.subject }).ok).toBe(false)
    expect(evaluateSignatures(signed, null).ok).toBe(false)
  })
  it('parses the PowerShell probe output', () => {
    expect(parseSignatureJson('{"status":"Valid","subject":"CN=A"}\r\n')).toEqual({ status: 'Valid', subject: 'CN=A' })
    expect(parseSignatureJson('garbage')).toBeNull()
  })
})

describe('the signature check fails closed (finding 7)', () => {
  const signed = { status: 'Valid', subject: 'CN=Mark Relph' }
  it('a packaged build refuses when the probe of the running exe failed', () => {
    const verdict = evaluateSignatures(null, null, { requireProbe: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.message).toMatch(/could not check its own signature/)
  })
  it('only a probe that definitively says NotSigned skips the check', () => {
    expect(evaluateSignatures({ status: 'NotSigned', subject: '' }, null, { requireProbe: true })).toEqual({ ok: true, enforced: false })
    for (const status of ['UnknownError', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible', '']) {
      expect(evaluateSignatures({ status, subject: '' }, null, { requireProbe: true }).ok, status).toBe(false)
    }
  })
  it('a signed app still requires the same publisher', () => {
    expect(evaluateSignatures(signed, { ...signed }, { requireProbe: true })).toEqual({ ok: true, enforced: true })
    expect(evaluateSignatures(signed, null, { requireProbe: true }).ok).toBe(false)
  })
})

describe('every redirect hop is checked (finding 12)', () => {
  const start = 'https://github.com/mrelph/InkwellWindows/releases/download/v1.2.3/Inkwell-Setup-1.2.3-x64.exe'
  it('follows hops to GitHub asset hosts, resolving relative locations', () => {
    expect(checkRedirect(start, 'https://objects.githubusercontent.com/x?sig=1', 1)).toEqual({ ok: true, url: 'https://objects.githubusercontent.com/x?sig=1' })
    expect(checkRedirect('https://release-assets.githubusercontent.com/a/b', '/c', 2)).toEqual({ ok: true, url: 'https://release-assets.githubusercontent.com/c' })
  })
  it('stops at an untrusted host, plain http, credentials, odd ports or too many hops', () => {
    for (const location of [
      'https://evil.example/x.exe',
      'http://objects.githubusercontent.com/x',
      'https://user:pw@objects.githubusercontent.com/x',
      'https://objects.githubusercontent.com:8443/x',
      'https://objects.githubusercontent.com.evil.example/x',
      'file:///C:/x.exe',
      '',
      undefined
    ]) expect(checkRedirect(start, location, 1).ok, String(location)).toBe(false)
    expect(checkRedirect(start, 'https://objects.githubusercontent.com/x', MAX_REDIRECTS + 1).ok).toBe(false)
    expect(checkRedirect(start, 'https://objects.githubusercontent.com/x', MAX_REDIRECTS).ok).toBe(true)
  })
})
