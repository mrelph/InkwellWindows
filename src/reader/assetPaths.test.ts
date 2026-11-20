import { describe, expect, it } from 'vitest'
import { ASSET_SCHEME } from '../../src-electron/ipc/contract'
import { ASSET_SCHEME_NAME, assetUrl, dirOf, resolveImageSource, uncShare } from './assetPaths'

const note = 'C:\\Users\\me\\Notes\\a.md'

describe('resolveImageSource', () => {
  it('keeps the scheme name in sync with the contract', () => {
    expect(ASSET_SCHEME_NAME).toBe(ASSET_SCHEME)
  })
  it('resolves relative paths against the note folder', () => {
    expect(resolveImageSource('img/x.png', note)).toEqual({ kind: 'local', path: 'C:\\Users\\me\\Notes/img/x.png' })
    expect(resolveImageSource('./x.png', note)).toEqual({ kind: 'local', path: 'C:\\Users\\me\\Notes/./x.png' })
    expect(resolveImageSource('a%20b.png', note)).toEqual({ kind: 'local', path: 'C:\\Users\\me\\Notes/a b.png' })
  })
  it('handles a note at a drive root and posix notes', () => {
    expect(resolveImageSource('x.png', 'C:\\a.md')).toEqual({ kind: 'local', path: 'C:\\x.png' })
    expect(resolveImageSource('x.png', '/home/u/a.md')).toEqual({ kind: 'local', path: '/home/u/x.png' })
  })
  it('blocks relative paths for drafts', () => {
    expect(resolveImageSource('x.png', undefined).kind).toBe('blocked')
  })
  it('accepts absolute Windows, rooted, ~ and ../ paths (Mac Paths.resolveImage)', () => {
    expect(resolveImageSource('D:\\pics\\x.png')).toEqual({ kind: 'local', path: 'D:\\pics\\x.png' })
    expect(resolveImageSource('D:/pics/x.png')).toEqual({ kind: 'local', path: 'D:/pics/x.png' })
    expect(resolveImageSource('~/x.png')).toEqual({ kind: 'local', path: '~/x.png' })
    expect(resolveImageSource('/x.png')).toEqual({ kind: 'local', path: '/x.png' })
    expect(resolveImageSource('../assets/x.png', note)).toEqual({ kind: 'local', path: 'C:\\Users\\me\\Notes/../assets/x.png' })
  })
  it('never requests a network share the note is not on (no NTLM leak)', () => {
    for (const src of [
      '\\\\srv\\share\\x.png',
      '%5C%5Csrv%5Cshare%5Cx.png',
      '\\\\attacker@SSL\\DavWWWRoot\\x.png',
      '\\\\?\\C:\\x.png',
      '\\\\.\\pipe\\x.png',
      'file://srv/share/x.png',
      'FILE://attacker.example/share/x.png'
    ]) expect(resolveImageSource(src, note), src).toEqual({ kind: 'network' })
  })
  it('loads images on the share a note itself lives on', () => {
    const nasNote = '\\\\NAS\\Notes\\work\\plan.md'
    expect(resolveImageSource('img/x.png', nasNote)).toEqual({ kind: 'local', path: '\\\\NAS\\Notes\\work/img/x.png' })
    expect(resolveImageSource('\\\\nas\\notes\\pics\\x.png', nasNote)).toEqual({ kind: 'local', path: '\\\\nas\\notes\\pics\\x.png' })
    expect(resolveImageSource('file://nas/notes/x.png', nasNote)).toEqual({ kind: 'local', path: '\\\\nas\\notes\\x.png' })
    expect(resolveImageSource('\\\\nas\\other\\x.png', nasNote)).toEqual({ kind: 'network' })
    expect(resolveImageSource('\\\\evil\\notes\\x.png', nasNote)).toEqual({ kind: 'network' })
  })
  it('uncShare', () => {
    expect(uncShare('\\\\Srv\\Share\\a')).toBe('\\\\srv\\share')
    expect(uncShare('//srv/share')).toBe('\\\\srv\\share')
    expect(uncShare('\\\\?\\UNC\\srv\\share')).toBeNull()
    expect(uncShare('C:\\a')).toBeNull()
  })
  it('parses file: URLs', () => {
    expect(resolveImageSource('file:///C:/a%20b/x.png')).toEqual({ kind: 'local', path: 'C:/a b/x.png' })
    expect(resolveImageSource('file://localhost/C:/x.png')).toEqual({ kind: 'local', path: 'C:/x.png' })
    expect(resolveImageSource('file:///home/u/x.png')).toEqual({ kind: 'local', path: '/home/u/x.png' })
    expect(resolveImageSource('file:x.png').kind).toBe('blocked')
  })
  it('never fetches remote images', () => {
    for (const src of ['http://a/x.png', 'HTTPS://a/x.png', '//a/x.png']) expect(resolveImageSource(src, note).kind).toBe('remote')
  })
  it('rejects data:, javascript: and other schemes', () => {
    for (const src of ['data:image/png;base64,AA', 'javascript:alert(1)', 'blob:x', 'ftp://a/x.png', 'inkwell-asset://local/?f=x', '', '  ', 'a\0b.png']) {
      expect(resolveImageSource(src, note).kind).toBe('blocked')
    }
  })
})

describe('assetUrl / dirOf', () => {
  it('encodes path and root', () => {
    const url = new URL(assetUrl('C:\\a b\\x.png', note))
    expect(url.protocol).toBe(`${ASSET_SCHEME}:`)
    expect(url.searchParams.get('f')).toBe('C:\\a b\\x.png')
    expect(url.searchParams.get('r')).toBe('C:\\Users\\me\\Notes')
  })
  it('omits the root for drafts', () => {
    expect(new URL(assetUrl('C:\\x.png')).searchParams.has('r')).toBe(false)
  })
  it('dirOf', () => {
    expect(dirOf('C:\\a.md')).toBe('C:\\')
    expect(dirOf('/a.md')).toBe('/')
    expect(dirOf('a.md')).toBe('')
  })
})
