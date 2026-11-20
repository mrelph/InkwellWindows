import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LIBRARY_FOLDERS,
  checkLibraryFolder,
  forgetDocument,
  forgetTrustedDocuments,
  isKnownLibraryFolder,
  isTrustedDocument,
  libraryFolders,
  mayReadDocument,
  mayWriteDocument,
  onPersistedDocumentsChange,
  persistedDocuments,
  restorePersistedDocuments,
  retainLibraryFolders,
  setHomeFolder,
  trustDocument,
  trustDocuments,
  trustLibraryFolder,
  trustReadableDocument,
  trustStoredLibrary
} from './trustedDocuments'

const win = path.win32

beforeEach(() => {
  forgetTrustedDocuments()
  onPersistedDocumentsChange(null)
  setHomeFolder('C:\\Users\\me')
})

describe('write authority: only documents main handed out', () => {
  it('the arbitrary-write finding: a path main never handed out is not writable', () => {
    trustDocument('C:\\Users\\me\\Notes\\a.md', win)
    expect(mayWriteDocument('C:\\Users\\me\\Notes\\a.md', win)).toBe(true)
    expect(mayWriteDocument('c:\\USERS\\me\\notes\\A.md', win)).toBe(true)
    for (const target of [
      'C:\\Users\\me\\AppData\\Local\\Temp\\evil.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd',
      'C:\\Users\\me\\Notes\\b.md',
      'C:\\Users\\me\\Notes\\a.md.cmd',
      'C:\\Users\\me\\Notes\\a.md:stream',
      'C:\\Users\\me\\Notes\\sub\\..\\..\\.ssh\\config.md',
      '\\\\?\\C:\\Users\\me\\Notes\\a.md',
      'relative\\a.md',
      42
    ]) expect(mayWriteDocument(target, win), String(target)).toBe(false)
  })
  it('keeps Markdown-only even for a trusted folder', () => {
    trustDocument('C:\\n\\image.png', win)
    expect(mayWriteDocument('C:\\n\\image.png', win)).toBe(false)
  })
  it('a renamed-away or trashed document stops being writable', () => {
    trustDocument('C:\\n\\a.md', win)
    forgetDocument('C:\\n\\a.md', win)
    expect(mayWriteDocument('C:\\n\\a.md', win)).toBe(false)
  })
})

describe('read authority', () => {
  it('reads writable and readable documents, and Markdown inside a library folder', () => {
    trustDocument('C:\\n\\a.md', win)
    trustReadableDocument('D:\\linked\\b.md', win)
    trustLibraryFolder('E:\\Library', win)
    expect(mayReadDocument('C:\\n\\a.md', win)).toBe(true)
    expect(mayReadDocument('D:\\linked\\b.md', win)).toBe(true)
    expect(mayReadDocument('E:\\Library\\deep\\c.md', win)).toBe(true)
    expect(mayReadDocument('E:\\Library\\deep\\c.txt', win)).toBe(false)
    expect(mayReadDocument('E:\\Library2\\c.md', win)).toBe(false)
    expect(mayReadDocument('E:\\Library\\..\\c.md', win)).toBe(false)
    expect(mayReadDocument('C:\\Windows\\x.md', win)).toBe(false)
  })
  it('a readable document is not writable, and trusting it never downgrades a writable one', () => {
    trustReadableDocument('D:\\linked\\b.md', win)
    expect(mayWriteDocument('D:\\linked\\b.md', win)).toBe(false)
    trustDocument('C:\\n\\a.md', win)
    trustReadableDocument('C:\\n\\a.md', win)
    expect(mayWriteDocument('C:\\n\\a.md', win)).toBe(true)
  })
  it('a UNC path is readable only when main vouched for it or inside a UNC library folder', () => {
    expect(mayReadDocument('\\\\attacker\\share\\x.md', win)).toBe(false)
    trustLibraryFolder('C:\\Notes', win)
    expect(mayReadDocument('\\\\attacker\\share\\x.md', win)).toBe(false)
    trustLibraryFolder('\\\\nas\\notes', win)
    expect(mayReadDocument('\\\\NAS\\Notes\\a.md', win)).toBe(true)
    expect(mayReadDocument('\\\\nas\\other\\a.md', win)).toBe(false)
  })
})

describe('library folders: main-known only', () => {
  it('refuses drive roots, the home folder and folders holding it', () => {
    expect(trustLibraryFolder('C:\\', win).ok).toBe(false)
    expect(trustLibraryFolder('C:\\Users\\me', win).ok).toBe(false)
    expect(trustLibraryFolder('C:\\Users', win).ok).toBe(false)
    expect(checkLibraryFolder('relative', win).ok).toBe(false)
    expect(trustLibraryFolder('C:\\Users\\me\\Notes', win)).toEqual({ ok: true, folder: 'C:\\Users\\me\\Notes' })
    expect(libraryFolders()).toEqual(['C:\\Users\\me\\Notes'])
  })
  it('a renderer state save can remove folders but never add an unknown one', () => {
    trustLibraryFolder('C:\\A', win)
    trustLibraryFolder('C:\\B', win)
    expect(retainLibraryFolders(['c:\\b', 'C:\\Evil', 'C:\\', '\\\\attacker\\share', 42, 'C:\\B'], win)).toEqual(['C:\\B'])
    expect(libraryFolders()).toEqual(['C:\\B'])
    expect(isKnownLibraryFolder('C:\\Evil', win)).toBe(false)
    // A stale save that dropped A does not stop A coming back in a later save
    // (it is still known: the user chose it), but Evil never appears.
    expect(retainLibraryFolders(['C:\\A', 'C:\\B', 'C:\\Evil'], win)).toEqual(['C:\\A', 'C:\\B'])
  })
  it('caps the active library', () => {
    for (let index = 0; index < MAX_LIBRARY_FOLDERS + 3; index += 1) trustLibraryFolder(`D:\\f${index}`, win)
    expect(libraryFolders()).toHaveLength(MAX_LIBRARY_FOLDERS)
  })
})

describe('startup: library.json and main’s own persisted record', () => {
  it('library.json folders become known; its Recent files become readable, not writable', () => {
    const accepted = trustStoredLibrary({
      folders: ['C:\\Users\\me\\Notes', 'C:\\', 'C:\\Users\\me', 'relative'],
      recent: [{ path: 'D:\\old\\a.md' }, { path: 'D:\\old\\b.cmd' }, null, { path: 42 }],
      activePath: 'D:\\old\\c.md'
    }, win)
    expect(accepted).toEqual(['C:\\Users\\me\\Notes'])
    expect(mayReadDocument('D:\\old\\a.md', win)).toBe(true)
    expect(mayReadDocument('D:\\old\\c.md', win)).toBe(true)
    expect(mayWriteDocument('D:\\old\\a.md', win)).toBe(false)
    expect(mayReadDocument('D:\\old\\b.cmd', win)).toBe(false)
  })
  it('persists writable documents from dialogs/argv/saves, not from library walks', () => {
    let changes = 0
    onPersistedDocumentsChange(() => { changes += 1 })
    trustDocuments([{ path: 'C:\\walk\\a.md' }], win)
    trustDocument('C:\\saved\\b.md', win, { persist: true })
    expect(persistedDocuments()).toEqual(['C:\\saved\\b.md'])
    expect(changes).toBe(1)
    forgetDocument('C:\\saved\\b.md', win)
    expect(persistedDocuments()).toEqual([])
    expect(changes).toBe(2)
  })
  it('restoring the persisted record makes those documents writable again', () => {
    restorePersistedDocuments(['C:\\saved\\b.md', 'C:\\saved\\x.cmd', 7, '\\\\?\\C:\\y.md'], win)
    expect(isTrustedDocument('C:\\saved\\b.md', win)).toBe(true)
    expect(mayWriteDocument('C:\\saved\\x.cmd', win)).toBe(false)
    expect(persistedDocuments()).toEqual(['C:\\saved\\b.md'])
  })
})
