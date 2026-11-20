import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* The document IPC handlers against a real temp folder, with Electron and the
   sender guard stubbed. Finding 1 (main writes only what it handed out),
   finding 2 (no fs call for a UNC path), finding 4 (library trust). Every
   node:fs/promises call the handlers make is recorded. */

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  fsCalls: [] as string[],
  userData: '',
  documents: ''
}))

vi.mock('../ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn),
  on: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn)
}))

const dialog = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 }))
}))
const shell = vi.hoisted(() => ({ trashItem: vi.fn(async () => undefined), showItemInFolder: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? hoisted.userData : name === 'home' ? nodePath.join(hoisted.userData, 'home') : hoisted.documents) },
  dialog,
  shell,
  clipboard: { writeText: vi.fn() }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] = typeof value === 'function'
      ? (...args: unknown[]) => {
          hoisted.fsCalls.push(`${name} ${String(args[0])}`)
          return (value as (...a: unknown[]) => unknown)(...args)
        }
      : value
  }
  return { ...wrapped, default: wrapped }
})

const base = mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-docs-'))
hoisted.userData = nodePath.join(base, 'userData')
hoisted.documents = nodePath.join(base, 'Documents')
mkdirSync(hoisted.userData, { recursive: true })
mkdirSync(nodePath.join(hoisted.userData, 'home'), { recursive: true })
const notes = nodePath.join(base, 'Notes')
mkdirSync(notes, { recursive: true })
const library = nodePath.join(base, 'Library')
mkdirSync(nodePath.join(library, 'sub'), { recursive: true })
writeFileSync(nodePath.join(notes, 'a.md'), '# A\n\n[b](b.md)')
writeFileSync(nodePath.join(notes, 'b.md'), '# B')
writeFileSync(nodePath.join(library, 'sub', 'lib.md'), '# Lib')
/* library.json as an earlier session left it: one good folder, two broad ones. */
writeFileSync(nodePath.join(hoisted.userData, 'library.json'), JSON.stringify({
  folders: [library, nodePath.parse(base).root, nodePath.join(hoisted.userData, 'home')],
  recent: [{ path: nodePath.join(notes, 'b.md'), name: 'b.md', openedAt: 1 }]
}))

const { initialiseDocumentTrust, registerDocumentIpc } = await import('./documents')
const event = {}
const call = <T,>(channel: string, ...args: unknown[]) => hoisted.handlers.get(channel)!(event, ...args) as Promise<T>

beforeAll(async () => {
  await initialiseDocumentTrust()
  registerDocumentIpc(() => null)
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
beforeEach(() => {
  hoisted.fsCalls = []
  dialog.showSaveDialog.mockReset()
  dialog.showOpenDialog.mockReset()
})

const openViaDialog = async (file: string) => {
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] })
  return call<Array<{ path: string }>>('document:open')
}

describe('document:save writes only what main handed out (finding 1)', () => {
  it('refuses a non-Markdown path outright: no dialog, nothing written', async () => {
    const evil = nodePath.join(os.tmpdir(), `inkwell-evil-${Date.now()}.cmd`)
    const result = await call<{ canceled: boolean; refused?: string }>('document:save', { content: '@echo pwned', path: evil })
    expect(result).toMatchObject({ canceled: true, refused: expect.any(String) })
    expect(existsSync(evil)).toBe(false)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(hoisted.fsCalls.filter((entry) => entry.includes('inkwell-evil'))).toEqual([])
  })
  it('sends an untrusted Markdown path to a Save dialog seeded with it; cancel writes nothing', async () => {
    const target = nodePath.join(base, 'Elsewhere', 'x.md')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await call('document:save', { content: 'x', path: target })).toEqual({ canceled: true })
    expect(dialog.showSaveDialog.mock.calls[0]?.at(-1)).toMatchObject({ defaultPath: target })
    expect(existsSync(target)).toBe(false)
  })
  it('saves a document opened through the dialog in place', async () => {
    const file = nodePath.join(notes, 'a.md')
    await openViaDialog(file)
    const result = await call<{ canceled: boolean; path: string }>('document:save', { content: '# A edited', path: file })
    expect(result).toMatchObject({ canceled: false, path: file })
    expect(readFileSync(file, 'utf8')).toBe('# A edited')
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })
  it('Save As writes where the dialog says, adding .md, and that path is then writable', async () => {
    const chosen = nodePath.join(notes, 'fresh')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosen })
    const result = await call<{ path: string }>('document:save', { content: 'new', forceSaveAs: true })
    expect(result.path).toBe(`${chosen}.md`)
    expect(readFileSync(`${chosen}.md`, 'utf8')).toBe('new')
    expect(await call('document:save', { content: 'again', path: `${chosen}.md` })).toMatchObject({ canceled: false })
    expect(readFileSync(`${chosen}.md`, 'utf8')).toBe('again')
    // Main persisted it in its own record, which library.json cannot forge.
    await vi.waitFor(() => expect(readFileSync(nodePath.join(hoisted.userData, 'trusted-documents.json'), 'utf8')).toContain('fresh.md'))
  })
})

describe('rename, duplicate, trash and reveal need main’s authority too', () => {
  it('refuses paths main never handed out', async () => {
    const stranger = nodePath.join(base, 'stranger.md')
    writeFileSync(stranger, 'x')
    expect(await call('file:rename', { path: stranger, name: 'y.md' })).toMatchObject({ ok: false })
    expect(await call('file:duplicate', stranger)).toBeNull()
    expect(await call('file:trash', stranger)).toBe(false)
    await call('file:reveal', stranger)
    expect(shell.trashItem).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(existsSync(stranger)).toBe(true)
  })
  it('renames a trusted document, and the old path stops being writable', async () => {
    const file = nodePath.join(notes, 'rename-me.md')
    writeFileSync(file, 'r')
    await openViaDialog(file)
    const renamed = await call<{ ok: boolean; path: string }>('file:rename', { path: file, name: 'renamed.md' })
    expect(renamed).toMatchObject({ ok: true, path: nodePath.join(notes, 'renamed.md') })
    expect(await call('file:rename', { path: file, name: 'again.md' })).toMatchObject({ ok: false })
    const copy = await call<{ path: string } | null>('file:duplicate', renamed.path)
    expect(copy?.path).toMatch(/renamed.*copy/i)
  })
})

describe('library folders come from main only (finding 4)', () => {
  it('state:load offers only folders main accepted at startup (no drive root, no home)', async () => {
    const state = await call<{ folders: string[] }>('state:load')
    expect(state.folders).toEqual([library])
  })
  it('document:read-folder reads only known folders', async () => {
    expect((await call<{ documents: unknown[] }>('document:read-folder', library)).documents).toHaveLength(1)
    expect(await call('document:read-folder', notes)).toEqual({ folder: '', documents: [] })
  })
  it('Add Folder refuses a broad folder with a reason', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [nodePath.join(hoisted.userData, 'home')] })
    expect(await call('document:open-folder')).toMatchObject({ folder: '', refused: expect.stringMatching(/home folder/) })
  })
  it('state:save can drop a folder but not add one', async () => {
    await call('state:save', { folders: [library, notes, '\\\\attacker\\share'], recent: [{ path: nodePath.join(base, 'x.md'), name: 'x', openedAt: 0 }], readerFont: 'editorial', zoomLevel: 100, view: 'split', ephyLinks: {} })
    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(nodePath.join(hoisted.userData, 'library.json'), 'utf8'))
      expect(saved.folders).toEqual([library])
      expect(saved.recent).toEqual([])
    })
  })
})

describe('reads and reader links (findings 1 and 6)', () => {
  it('reads a Recent file from library.json, but it is read-only until saved through a dialog', async () => {
    const recent = nodePath.join(notes, 'b.md')
    expect((await call<unknown[]>('document:read', [recent, nodePath.join(base, 'stranger.md')])).length).toBe(1)
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await call('document:save', { content: 'x', path: recent })
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1)
  })
  it('opens a relative link from a trusted note; the target becomes readable', async () => {
    const from = nodePath.join(notes, 'a.md')
    const result = await call<{ ok: boolean; document?: { path: string } }>('document:open-link', { from, href: 'b.md' })
    expect(result).toMatchObject({ ok: true, document: { path: nodePath.join(notes, 'b.md') } })
    expect(await call('document:open-link', { from, href: 'missing.md' })).toEqual({ ok: false, reason: 'missing.md is not there' })
    expect(await call('document:open-link', { from, href: 'picture.png' })).toEqual({ ok: false, reason: '' })
    expect(await call('document:open-link', { from: nodePath.join(base, 'stranger.md'), href: 'b.md' })).toEqual({ ok: false, reason: '' })
  })
})

describe('no fs call ever happens for a UNC path (finding 2)', () => {
  it('every handler refuses \\\\attacker\\share lexically', async () => {
    const unc = '\\\\attacker\\share\\x.md'
    await call('document:read', [unc, '//attacker/share/y.md'])
    await call('document:read-folder', '\\\\attacker\\share')
    await call('document:save', { content: 'x', path: '\\\\attacker\\share\\x.cmd' })
    await call('file:rename', { path: unc, name: 'y.md' })
    await call('file:duplicate', unc)
    await call('file:trash', unc)
    await call('file:reveal', unc)
    await call('document:open-link', { from: nodePath.join(notes, 'a.md'), href: 'file://attacker/share/x.md' })
    await call('document:open-link', { from: unc, href: 'b.md' })
    expect(hoisted.fsCalls.filter((entry) => /attacker/i.test(entry))).toEqual([])
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})
