import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetUrl, resolveImageSource } from '../src/reader/assetPaths'
import { authorizeAsset, imageMimeType, parseAssetUrl } from './assetGuard'
import { setNetworkDrives } from './pathRules'
import { MAX_TRUSTED_FOLDERS, forgetTrustedDocuments, isTrustedNoteFolder, trustDocument, trustDocuments } from './trustedDocuments'

/* The asset scheme's policy (Match Mac): any LOCAL image loads; network
   paths only inside a trusted root on that share, refused before any fs call. */

const win = path.win32
const home = 'C:\\Users\\me'
const links: Record<string, string> = {}
/** Every path the guard handed to "the file system" (realpath). */
let touched: string[] = []
const deps = {
  pathApi: win,
  home,
  realpath: async (p: string) => {
    touched.push(p)
    const key = p.toLowerCase()
    if (key.includes('missing')) throw new Error('ENOENT')
    return links[key] ?? p
  },
  isTrustedRoot: (folder: string) => isTrustedNoteFolder(folder, win)
}
const note = 'C:\\Users\\me\\Notes'

beforeEach(() => {
  forgetTrustedDocuments()
  touched = []
  for (const key of Object.keys(links)) delete links[key]
  trustDocument('C:\\Users\\me\\Notes\\today.md', win)
  trustDocument('C:\\root.md', win)
  trustDocument('\\\\nas\\notes\\work\\plan.md', win)
})
afterEach(() => setNetworkDrives([]))

const ask = (file: string, root: string | undefined = note, folders: string[] = ['D:\\Library']) =>
  authorizeAsset({ file, root }, folders, deps)

describe('parseAssetUrl', () => {
  it('reads f and r', () => {
    expect(parseAssetUrl('inkwell-asset://local/?f=C%3A%5Ca.png&r=C%3A%5C')).toEqual({ file: 'C:\\a.png', root: 'C:\\' })
    expect(parseAssetUrl('inkwell-asset://local/?r=x')).toBeNull()
    expect(parseAssetUrl('not a url')).toBeNull()
  })
})

describe('imageMimeType', () => {
  it('allows only image extensions', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) expect(imageMimeType(`a.${ext.toUpperCase()}`)).toMatch(/^image\//)
    for (const f of ['a.md', 'a.txt', 'a.html', 'a.exe', 'a', 'a.png.js']) expect(imageMimeType(f)).toBeNull()
  })
})

describe('authorizeAsset (win32): any local image, as on the Mac', () => {
  it('serves images in and below the note folder', async () => {
    expect(await ask('C:\\Users\\me\\Notes/img/../img/x.png')).toMatchObject({ ok: true, type: 'image/png' })
    expect(await ask('c:\\users\\ME\\notes\\sub\\x.JPG')).toMatchObject({ ok: true, type: 'image/jpeg' })
  })
  it('serves ../ relative images, other folders and other local drives', async () => {
    expect(await ask('C:\\Users\\me\\Notes\\..\\assets\\x.png')).toMatchObject({ ok: true, file: 'C:\\Users\\me\\assets\\x.png' })
    expect(await ask('C:\\Users\\me\\Pictures\\x.png', undefined, [])).toMatchObject({ ok: true })
    expect(await ask('E:\\x.png', undefined, [])).toMatchObject({ ok: true })
  })
  it('expands ~ against the home folder', async () => {
    expect(await ask('~/Pictures/x.png')).toMatchObject({ ok: true, file: 'C:\\Users\\me\\Pictures\\x.png' })
  })
  it('refuses non-images, also when a link points a .png at something else', async () => {
    expect(await ask('C:\\Users\\me\\Notes\\a.md')).toMatchObject({ ok: false, reason: 'not an image type' })
    expect(await ask('C:\\Users\\me\\Notes\\a.html')).toMatchObject({ ok: false })
    links['c:\\users\\me\\notes\\notimg.png'] = 'C:\\Users\\me\\Notes\\data.txt'
    expect(await ask('C:\\Users\\me\\Notes\\notimg.png')).toMatchObject({ ok: false, reason: 'not an image type' })
  })
  it('refuses relative, drive-relative, device and malformed paths without touching the disk', async () => {
    for (const file of ['x.png', 'C:x.png', '\\x.png', '\\\\?\\C:\\x.png', '\\\\.\\C:\\x.png', 'C:\\Users\\me\\Notes\\x\0.png']) {
      expect(await ask(file)).toMatchObject({ ok: false })
    }
    expect(touched).toEqual([])
  })
  it('answers not found for a missing file', async () => {
    expect(await ask('C:\\Users\\me\\Notes\\missing.png')).toMatchObject({ ok: false, reason: 'not found' })
  })
})

describe('authorizeAsset: network paths are refused LEXICALLY (no NTLM leak)', () => {
  it('the reviewer scenario: file://attacker/share/x.png from a local note never reaches fs', async () => {
    const notePath = 'C:\\Users\\me\\Notes\\note.md'
    // The renderer does not even ask for it…
    expect(resolveImageSource('file://attacker.example/share/x.png', notePath)).toEqual({ kind: 'network' })
    // …and a compromised renderer that asks anyway is refused before realpath.
    const request = parseAssetUrl(assetUrl('\\\\attacker.example\\share\\x.png', notePath))!
    const verdict = await authorizeAsset(request, [note], deps)
    expect(verdict).toEqual({ ok: false, reason: 'network path' })
    expect(touched).toEqual([])
  })
  it('refuses every UNC and device spelling before any fs call', async () => {
    for (const file of [
      '\\\\attacker\\share\\x.png',
      '//attacker/share/x.png',
      '\\\\attacker@SSL\\DavWWWRoot\\x.png',
      '\\\\attacker@8080\\share\\x.png',
      '\\\\?\\UNC\\attacker\\share\\x.png',
      '\\\\.\\UNC\\attacker\\share\\x.png'
    ]) {
      expect(await ask(file, note, ['D:\\Library', note])).toMatchObject({ ok: false })
    }
    expect(touched).toEqual([])
  })
  it('a renderer naming a UNC folder as the note folder gains nothing', async () => {
    expect(await ask('\\\\attacker\\share\\x.png', '\\\\attacker\\share')).toMatchObject({ ok: false, reason: 'network path' })
    expect(touched).toEqual([])
  })
  it('allows a share only inside a UNC library folder or a trusted note folder on it', async () => {
    expect(await ask('\\\\nas\\pics\\a\\x.png', undefined, ['\\\\nas\\pics'])).toMatchObject({ ok: true })
    expect(await ask('\\\\NAS\\Notes\\work\\img\\x.png', '\\\\nas\\notes\\work', [])).toMatchObject({ ok: true })
    // Outside that folder on the same server: refused, untouched.
    touched = []
    expect(await ask('\\\\nas\\other\\x.png', '\\\\nas\\notes\\work', ['\\\\nas\\pics'])).toMatchObject({ ok: false, reason: 'network path' })
    expect(touched).toEqual([])
  })
  it('treats a mapped network drive like its share', async () => {
    setNetworkDrives(['x'])
    expect(await ask('X:\\pics\\x.png', note, [])).toMatchObject({ ok: false, reason: 'network path' })
    expect(touched).toEqual([])
    expect(await ask('X:\\pics\\x.png', undefined, ['X:\\pics'])).toMatchObject({ ok: true })
  })
  it('refuses a local spelling whose real path is on a share, unless a trusted root is too', async () => {
    links['c:\\users\\me\\notes\\escape.png'] = '\\\\?\\UNC\\nas\\private\\secret.png'
    expect(await ask('C:\\Users\\me\\Notes\\escape.png', note, [])).toMatchObject({ ok: false, reason: 'network path' })
    // Z: is a mapped drive `net use` has not reported yet: realpath says so.
    links['z:\\lib\\x.png'] = '\\\\?\\UNC\\nas\\lib\\x.png'
    links['z:\\lib'] = '\\\\?\\UNC\\nas\\lib'
    expect(await ask('Z:\\lib\\x.png', undefined, ['Z:\\lib'])).toMatchObject({ ok: true, file: '\\\\nas\\lib\\x.png' })
    expect(await ask('Z:\\lib\\x.png', undefined, [])).toMatchObject({ ok: false, reason: 'network path' })
  })
  it('a drive root never counts as the note folder for a share', async () => {
    setNetworkDrives(['Y'])
    trustDocument('Y:\\root.md', win)
    expect(await ask('Y:\\x.png', 'Y:\\', [])).toMatchObject({ ok: false, reason: 'network path' })
  })
})

describe('note folders main vouches for', () => {
  it('records folders from document lists and ignores junk', () => {
    trustDocuments([{ path: 'E:\\Work\\a.md' }, null, undefined], win)
    trustDocument('relative\\b.md', win)
    trustDocument(42, win)
    trustDocument('E:\\x\0\\c.md', win)
    expect(isTrustedNoteFolder('e:\\work', win)).toBe(true)
    expect(isTrustedNoteFolder('relative', win)).toBe(false)
    expect(isTrustedNoteFolder('E:\\x', win)).toBe(false)
    expect(isTrustedNoteFolder('', win)).toBe(false)
  })
  it('is case-sensitive on posix', () => {
    trustDocument('/home/me/n/a.md', path.posix)
    expect(isTrustedNoteFolder('/home/me/n', path.posix)).toBe(true)
    expect(isTrustedNoteFolder('/home/me/N', path.posix)).toBe(false)
  })
  it('stays bounded, forgetting the oldest folder first', () => {
    forgetTrustedDocuments()
    for (let index = 0; index <= MAX_TRUSTED_FOLDERS; index += 1) trustDocument(`C:\\f${index}\\a.md`, win)
    expect(isTrustedNoteFolder('C:\\f0', win)).toBe(false)
    expect(isTrustedNoteFolder('C:\\f1', win)).toBe(true)
    expect(isTrustedNoteFolder(`C:\\f${MAX_TRUSTED_FOLDERS}`, win)).toBe(true)
  })
})

describe('authorizeAsset (posix)', () => {
  const posixDeps = {
    pathApi: path.posix,
    home: '/home/me',
    realpath: async (p: string) => p,
    isTrustedRoot: (folder: string) => isTrustedNoteFolder(folder, path.posix)
  }
  it('serves local images anywhere; `//` is an ordinary path there', async () => {
    expect(await authorizeAsset({ file: '/home/me/n/x.png', root: '/home/me/n' }, [], posixDeps)).toMatchObject({ ok: true })
    expect(await authorizeAsset({ file: '/etc/x.png' }, [], posixDeps)).toMatchObject({ ok: true })
    expect(await authorizeAsset({ file: '//srv/x.png' }, [], posixDeps)).toMatchObject({ ok: true })
    expect(await authorizeAsset({ file: '/etc/passwd' }, [], posixDeps)).toMatchObject({ ok: false })
  })
})
