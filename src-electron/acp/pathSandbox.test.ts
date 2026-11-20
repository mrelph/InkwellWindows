import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonical, isAbsolutePath, isBelow, isPlainName, PathSandbox, splitPath, stripExtendedPrefix } from './pathSandbox'

const base = mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-sandbox-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
const folder = (...names: string[]) => {
  const dir = nodePath.join(base, `case${counter++}`, ...names)
  mkdirSync(dir, { recursive: true })
  return dir
}
const file = (path: string, text = 'x') => writeFileSync(path, text)
const windows = process.platform === 'win32'
const nowhere = { home: nodePath.join(base, 'no-such-home') }

function link(target: string, path: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch {
    return false // creating a symlink needs a privilege on some Windows setups
  }
}

describe('PathSandbox on this machine', () => {
  it('allows files inside a root, including ones that do not exist yet', () => {
    const root = folder()
    file(nodePath.join(root, 'note.md'))
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.allows(nodePath.join(root, 'note.md'))).toBe(true)
    expect(sandbox.allows(nodePath.join(root, 'new.md'))).toBe(true)
    const resolved = sandbox.resolve(nodePath.join(root, 'note.md'))
    expect(resolved).toEqual({ ok: true, path: canonical(nodePath.join(root, 'note.md')) })
  })

  it('refuses .. escapes, the root itself, relative paths and missing folders', () => {
    const outer = folder()
    const root = nodePath.join(outer, 'sub')
    mkdirSync(root)
    file(nodePath.join(outer, 'secret.md'))
    const sandbox = new PathSandbox([root], nowhere)
    const sep = nodePath.sep
    expect(sandbox.resolve(`${root}${sep}..${sep}secret.md`)).toEqual({ ok: false, denial: 'outside' })
    expect(sandbox.resolve(`${root}${sep}..${sep}new.md`)).toEqual({ ok: false, denial: 'outside' })
    expect(sandbox.resolve(`${root}${sep}..`)).toEqual({ ok: false, denial: 'outside' })
    expect(sandbox.resolve(root)).toEqual({ ok: false, denial: 'outside' })
    expect(sandbox.resolve('sub/note.md')).toEqual({ ok: false, denial: 'notAbsolute' })
    expect(sandbox.resolve(nodePath.join(root, 'missing', 'new.md'))).toEqual({ ok: false, denial: 'missingFolder' })
  })

  it('refuses hidden files and folders inside a root', () => {
    const root = folder()
    mkdirSync(nodePath.join(root, '.git', 'hooks'), { recursive: true })
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.resolve(nodePath.join(root, '.git', 'hooks', 'pre-commit'))).toEqual({ ok: false, denial: 'hidden' })
    expect(sandbox.resolve(nodePath.join(root, '.env'))).toEqual({ ok: false, denial: 'hidden' })
  })

  it('refuses a sibling that merely shares the root as a prefix', () => {
    const parent = folder()
    const root = nodePath.join(parent, 'Notes')
    mkdirSync(root)
    mkdirSync(nodePath.join(parent, 'NotesSecret'))
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.resolve(nodePath.join(parent, 'NotesSecret', 'a.md'))).toEqual({ ok: false, denial: 'outside' })
  })

  it('compares case-insensitively on Windows only', () => {
    const parent = folder()
    const root = nodePath.join(parent, 'Notes')
    mkdirSync(root)
    file(nodePath.join(root, 'a.md'))
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.allows(nodePath.join(parent, 'NOTES', 'A.md'))).toBe(windows)
  })

  it('never takes the home folder or a filesystem root as a root', () => {
    const root = folder()
    expect(new PathSandbox([root], { home: root }).roots).toEqual([])
    expect(new PathSandbox([nodePath.parse(root).root, 'relative', nodePath.join(root, 'does', 'not', 'exist')], nowhere).roots).toEqual([])
  })

  it('de-duplicates roots that resolve to the same folder', () => {
    const root = folder()
    expect(new PathSandbox([root, root, root + nodePath.sep], nowhere).roots).toHaveLength(1)
  })

  it('resolves a folder junction/symlink before checking', () => {
    const root = folder()
    const outside = folder()
    file(nodePath.join(outside, 'secret.md'))
    if (!link(outside, nodePath.join(root, 'dir'), windows ? 'junction' : 'dir')) return
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.resolve(nodePath.join(root, 'dir', 'secret.md'))).toEqual({ ok: false, denial: 'outside' })
    expect(sandbox.resolve(nodePath.join(root, 'dir', 'new.md'))).toEqual({ ok: false, denial: 'outside' })
  })

  it('resolves a file symlink and refuses a dangling one', () => {
    const root = folder()
    const outside = folder()
    file(nodePath.join(outside, 'secret.md'))
    file(nodePath.join(root, 'real.md'))
    const outsideLink = link(nodePath.join(outside, 'secret.md'), nodePath.join(root, 'link.md'), 'file')
    const dangling = link(nodePath.join(outside, 'nothing.md'), nodePath.join(root, 'dangling.md'), 'file')
    const alias = link(nodePath.join(root, 'real.md'), nodePath.join(root, 'alias.md'), 'file')
    const sandbox = new PathSandbox([root], nowhere)
    if (outsideLink) expect(sandbox.resolve(nodePath.join(root, 'link.md'))).toEqual({ ok: false, denial: 'outside' })
    if (dangling) expect(sandbox.resolve(nodePath.join(root, 'dangling.md'))).toEqual({ ok: false, denial: 'outside' })
    if (alias) expect(sandbox.allows(nodePath.join(root, 'alias.md'))).toBe(true)
  })

  it('allows an unsaved draft\'s stand-in path with no roots, and only that exact path', () => {
    const root = folder()
    const draft = nodePath.join(root, 'Untitled note.md')
    const sandbox = new PathSandbox([], { files: [draft], ...nowhere })
    expect(sandbox.resolve(draft)).toEqual({ ok: true, path: draft })
    expect(sandbox.allows(nodePath.join(root, 'Other.md'))).toBe(false)
    expect(sandbox.files).toEqual([draft])
  })

  it.skipIf(!windows)('refuses names Windows rewrites: streams, trailing dots, device names', () => {
    const root = folder()
    const sandbox = new PathSandbox([root], nowhere)
    for (const name of ['note.md:stream', '.env.', 'note.md ', 'NUL', 'con.txt', 'a<b.md']) {
      expect(sandbox.resolve(`${root}\\${name}`), name).toMatchObject({ ok: false })
    }
  })

  it.skipIf(!windows)('treats 8.3 short names and real names as the same place', () => {
    const root = folder('Long Folder Name')
    file(nodePath.join(root, 'a.md'))
    const sandbox = new PathSandbox([root], nowhere)
    expect(sandbox.allows(nodePath.join(root, 'a.md'))).toBe(true)
  })
})

describe('Windows path rules, checked on any host', () => {
  it('knows what is absolute', () => {
    expect(isAbsolutePath('C:\\notes\\a.md', true)).toBe(true)
    expect(isAbsolutePath('c:/notes/a.md', true)).toBe(true)
    expect(isAbsolutePath('\\\\nas\\share\\notes\\a.md', true)).toBe(true)
    expect(isAbsolutePath('//nas/share/a.md', true)).toBe(true)
    expect(isAbsolutePath('C:notes\\a.md', true)).toBe(false) // drive-relative
    expect(isAbsolutePath('\\notes\\a.md', true)).toBe(false)
    expect(isAbsolutePath('notes\\a.md', true)).toBe(false)
    expect(isAbsolutePath('\\\\?\\C:\\notes\\a.md', true)).toBe(false) // device namespace
    expect(isAbsolutePath('\\\\.\\PhysicalDrive0', true)).toBe(false)
    expect(isAbsolutePath('\\\\nas', true)).toBe(false)
    expect(isAbsolutePath('C:\\a\u0000b', true)).toBe(false)
    expect(isAbsolutePath('/etc/passwd', false)).toBe(true)
    expect(isAbsolutePath('etc', false)).toBe(false)
  })

  it('splits drive and UNC roots', () => {
    expect(splitPath('C:\\Users\\Me\\a.md', true)).toEqual({ root: 'C:', names: ['Users', 'Me', 'a.md'] })
    expect(splitPath('\\\\nas\\share\\notes\\a.md', true)).toEqual({ root: '\\\\nas\\share', names: ['notes', 'a.md'] })
    expect(splitPath('//nas/share/notes', true)).toEqual({ root: '\\\\nas\\share', names: ['notes'] })
  })

  it('compares case-insensitively, by whole component', () => {
    expect(isBelow('C:\\Notes', 'c:\\NOTES\\A.md', true)).toBe(true)
    expect(isBelow('C:\\Notes', 'C:\\NotesSecret\\a.md', true)).toBe(false)
    expect(isBelow('C:\\Notes', 'C:\\Notes', true)).toBe(false)
    expect(isBelow('C:\\Notes', 'D:\\Notes\\a.md', true)).toBe(false)
    expect(isBelow('\\\\nas\\Share\\n', '\\\\NAS\\share\\N\\a.md', true)).toBe(true)
    expect(isBelow('\\\\nas\\share\\n', '\\\\nas\\other\\n\\a.md', true)).toBe(false)
    expect(isBelow('/notes', '/NOTES/a.md', false)).toBe(false)
    expect(isBelow('/notes', '/notes/a.md', false)).toBe(true)
  })

  it('refuses names Win32 would rewrite or treat specially', () => {
    for (const name of ['a.md:stream', 'a.md.', 'a.md ', 'CON', 'nul.txt', 'COM1', 'lpt9.md', 'a|b', 'a?.md', '']) {
      expect(isPlainName(name, true), name).toBe(false)
    }
    for (const name of ['a.md', 'Untitled note.md', 'aux-notes.md', 'console.md']) expect(isPlainName(name, true), name).toBe(true)
    expect(isPlainName('a:b.md', false)).toBe(true) // fine on POSIX
    expect(isPlainName('a/b', false)).toBe(false)
  })

  it('strips the extended-length prefix native realpath may return', () => {
    expect(stripExtendedPrefix('\\\\?\\C:\\notes\\a.md')).toBe('C:\\notes\\a.md')
    expect(stripExtendedPrefix('\\\\?\\UNC\\nas\\share\\a.md')).toBe('\\\\nas\\share\\a.md')
    expect(stripExtendedPrefix('C:\\notes')).toBe('C:\\notes')
  })
})
