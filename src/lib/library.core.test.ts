import { afterEach, describe, expect, it } from 'vitest'
import { MAX_FOLDERS, MAX_RECENT, MAX_EPHY_LINKS, clampZoom } from './limits'
import {
  DRAFTS, EPHY, RECENT, adoptIntoFolders, buildGroups, isClosable, kindForSource, mergeRestoredFolders, mergeRestoredRecent, rememberRecentEntries, rowFor, sourceForPath, toDoc,
  type FolderSource, type MarkdownDoc
} from './library'
import { clampTitle, fileIdFor, fileNameFor, folderIdFor, folderLabel, isInside, isMarkdown, pathKey, samePath } from './paths'

type Win = { window?: { inkwell?: { platform?: string } } }
const setPlatform = (platform: string | undefined) => {
  const g = globalThis as Win
  if (platform === undefined) delete g.window
  else g.window = { inkwell: { platform } }
}
afterEach(() => setPlatform(undefined))

describe('pathKey (explicit case flag)', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(pathKey('C:\\Notes\\a.md', false)).toBe('C:/Notes/a.md')
    expect(pathKey('C:\\Notes\\', false)).toBe('C:/Notes')
    expect(pathKey('/home/me//', false)).toBe('/home/me')
  })

  it('lowercases only when case-insensitive', () => {
    expect(pathKey('C:\\Notes\\A.MD', true)).toBe('c:/notes/a.md')
    expect(pathKey('C:\\Notes\\A.MD', false)).toBe('C:/Notes/A.MD')
  })

  it('handles UNC paths', () => {
    expect(pathKey('\\\\server\\share\\Notes\\', true)).toBe('//server/share/notes')
    expect(pathKey('//Server/Share/x.md', true)).toBe('//server/share/x.md')
  })

  it('treats different drive letters as different', () => {
    expect(pathKey('C:\\a', true)).not.toBe(pathKey('D:\\a', true))
    expect(pathKey('c:\\a', true)).toBe(pathKey('C:\\a', true))
  })
})

describe('platform-dependent path comparison', () => {
  it('is case-insensitive on win32 and ids agree', () => {
    setPlatform('win32')
    expect(samePath('C:\\Notes\\A.md', 'c:/notes/a.MD')).toBe(true)
    expect(fileIdFor('C:\\Notes\\A.md')).toBe(fileIdFor('c:/notes/a.md'))
    expect(fileIdFor('C:\\Notes\\A.md')).toBe('file:c:/notes/a.md')
    expect(folderIdFor('C:\\Notes\\')).toBe('folder:c:/notes')
  })

  it('is case-sensitive elsewhere', () => {
    setPlatform('linux')
    expect(samePath('/a/B.md', '/a/b.md')).toBe(false)
    expect(samePath('/a/b.md', '/a/b.md')).toBe(true)
  })

  it('defaults to case-sensitive without a bridge', () => {
    setPlatform(undefined)
    expect(samePath('/a/B.md', '/a/b.md')).toBe(false)
  })

  it('samePath is false for missing values', () => {
    expect(samePath(undefined, 'a')).toBe(false)
    expect(samePath('', '')).toBe(false)
  })
})

describe('names and extensions', () => {
  it('isMarkdown accepts md/mdx/markdown case-insensitively', () => {
    for (const name of ['a.md', 'a.MD', 'a.mdx', 'a.Markdown', 'C:\\x\\y.MDX']) expect(isMarkdown(name)).toBe(true)
  })

  it('isMarkdown rejects others', () => {
    for (const name of ['a.txt', 'a.md.bak', 'md', 'a.mdown', 'a.md ', '.md.png']) expect(isMarkdown(name)).toBe(false)
  })

  it('clampTitle strips the Markdown extension only', () => {
    expect(clampTitle('notes.md')).toBe('notes')
    expect(clampTitle('notes.MARKDOWN')).toBe('notes')
    expect(clampTitle('notes.txt')).toBe('notes.txt')
    expect(clampTitle('a.md.md')).toBe('a.md')
  })

  it('folderLabel/fileNameFor take the last segment with either separator', () => {
    expect(fileNameFor('C:\\a\\b\\c.md')).toBe('c.md')
    expect(fileNameFor('/a/b/c.md')).toBe('c.md')
    expect(folderLabel('C:\\a\\b\\')).toBe('b')
    expect(folderLabel('C:\\')).toBe('C:')
    expect(folderLabel('')).toBe('')
  })
})

describe('isInside', () => {
  it('matches the folder itself and descendants', () => {
    setPlatform('win32')
    expect(isInside('C:\\Notes', 'c:\\notes\\')).toBe(true)
    expect(isInside('C:\\Notes\\sub\\a.md', 'C:\\Notes')).toBe(true)
  })

  it('does not match a sibling that shares a prefix', () => {
    setPlatform('win32')
    expect(isInside('C:\\Notes2\\a.md', 'C:\\Notes')).toBe(false)
    expect(isInside('C:\\Notes', 'C:\\Notes\\sub')).toBe(false)
  })

  it('works for UNC and mixed separators', () => {
    setPlatform('win32')
    expect(isInside('\\\\srv\\share\\n\\a.md', '//SRV/share/n')).toBe(true)
    expect(isInside('\\\\srv\\share2\\a.md', '\\\\srv\\share')).toBe(false)
  })

  it('detects overlapping folders in both directions (the refusal rule)', () => {
    setPlatform('win32')
    const overlaps = (a: string, b: string) => isInside(a, b) || isInside(b, a)
    expect(overlaps('C:\\Notes', 'C:\\Notes\\Work')).toBe(true)
    expect(overlaps('C:\\Notes\\Work', 'C:\\Notes')).toBe(true)
    expect(overlaps('C:\\Notes', 'C:\\Other')).toBe(false)
    expect(overlaps('C:\\Notes', 'D:\\Notes')).toBe(false)
  })
})

const folders: FolderSource[] = [
  { id: folderIdFor('C:\\Notes'), name: 'Notes', path: 'C:\\Notes' },
  { id: folderIdFor('D:\\Work'), name: 'Work', path: 'D:\\Work' }
]
const doc = (name: string, sourceId: string, extra: Partial<MarkdownDoc> = {}): MarkdownDoc => ({
  id: `id:${name}:${sourceId}`, name, content: `body of ${name}`, sourceId, ...extra
})

describe('sourceForPath / toDoc', () => {
  it('maps files inside an added folder to that folder', () => {
    setPlatform('win32')
    expect(sourceForPath(folders, 'c:/notes/sub/a.md')).toBe(folders[0].id)
    expect(sourceForPath(folders, 'D:\\Work\\b.md')).toBe(folders[1].id)
  })

  it('falls back to recent', () => {
    setPlatform('win32')
    expect(sourceForPath(folders, 'E:\\x.md')).toBe(RECENT)
    expect(sourceForPath([], 'C:\\Notes\\a.md')).toBe(RECENT)
    expect(sourceForPath(folders, 'C:\\Notes2\\a.md')).toBe(RECENT)
  })

  it('toDoc keys the id on the path', () => {
    setPlatform('win32')
    const d = toDoc({ name: 'A.md', path: 'C:\\Notes\\A.md', content: 'x', savedAt: 5 }, folders[0].id)
    expect(d).toMatchObject({ id: 'file:c:/notes/a.md', sourceId: folders[0].id, savedAt: 5 })
  })
})

describe('kinds and closability', () => {
  it('kindForSource', () => {
    expect(kindForSource(DRAFTS)).toBe('drafts')
    expect(kindForSource(EPHY)).toBe('ephy')
    expect(kindForSource(RECENT)).toBe('recent')
    expect(kindForSource('folder:c:/x')).toBe('folder')
  })

  it('only drafts/ephy/recent rows are closable', () => {
    expect(isClosable(rowFor(doc('a', DRAFTS)))).toBe(true)
    expect(isClosable(rowFor(doc('a', EPHY)))).toBe(true)
    expect(isClosable(rowFor(doc('a', RECENT, { path: 'C:\\a.md' })))).toBe(true)
    expect(isClosable(rowFor(doc('a', folders[0].id)))).toBe(false)
    expect(isClosable(null)).toBe(false)
    expect(isClosable(undefined)).toBe(false)
  })

  it('row meta', () => {
    expect(rowFor(doc('a', DRAFTS)).meta).toBe('Draft')
    expect(rowFor(doc('a', EPHY)).meta).toBe('Ephy')
    expect(rowFor(doc('a', RECENT, { path: 'C:\\a.md' })).meta).toBe('Local file')
  })
})

describe('buildGroups', () => {
  it('orders Folders, Drafts, Ephy, Recent', () => {
    setPlatform('win32')
    const groups = buildGroups({
      documents: [
        doc('r', RECENT, { path: 'E:\\r.md' }),
        doc('e', EPHY),
        doc('d', DRAFTS),
        doc('f2', folders[1].id),
        doc('f1', folders[0].id)
      ],
      folders,
      recent: [],
      query: ''
    })
    expect(groups.map((g) => g.id)).toEqual([folders[0].id, folders[1].id, DRAFTS, EPHY, RECENT])
    expect(groups.map((g) => g.kind)).toEqual(['folder', 'folder', 'drafts', 'ephy', 'recent'])
  })

  it('keeps empty folder groups but omits empty drafts/ephy/recent', () => {
    const groups = buildGroups({ documents: [], folders, recent: [], query: '' })
    expect(groups.map((g) => g.id)).toEqual(folders.map((f) => f.id))
  })

  it('sorts rows within a folder by name', () => {
    const groups = buildGroups({
      documents: [doc('b.md', folders[0].id), doc('a.md', folders[0].id)],
      folders, recent: [], query: ''
    })
    expect(groups[0].rows.map((r) => r.name)).toEqual(['a.md', 'b.md'])
  })

  it('lists remembered recent files not yet open, and de-dupes against open ones', () => {
    setPlatform('win32')
    const groups = buildGroups({
      documents: [doc('open.md', RECENT, { path: 'E:\\Open.md' })],
      folders: [],
      recent: [
        { path: 'e:/open.md', name: 'open.md', openedAt: 2 },
        { path: 'E:\\other.md', name: 'other.md', openedAt: 1 }
      ],
      query: ''
    })
    const recent = groups.find((g) => g.id === RECENT)!
    expect(recent.rows.map((r) => [r.name, r.meta])).toEqual([['open.md', 'Local file'], ['other.md', 'Not open']])
  })

  it('does not list a recent entry that now lives inside an added folder', () => {
    setPlatform('win32')
    const groups = buildGroups({
      documents: [], folders,
      recent: [{ path: 'C:\\Notes\\a.md', name: 'a.md', openedAt: 1 }],
      query: ''
    })
    expect(groups.find((g) => g.id === RECENT)).toBeUndefined()
  })

  it('search filters rows and drops empty groups', () => {
    const groups = buildGroups({
      documents: [doc('alpha', folders[0].id), doc('beta', DRAFTS)],
      folders, recent: [{ path: 'E:\\gamma.md', name: 'gamma.md', openedAt: 1 }],
      query: ' ALPHA '
    })
    expect(groups.map((g) => g.id)).toEqual([folders[0].id])
  })

  it('search matches content and recent names', () => {
    const groups = buildGroups({
      documents: [doc('x', DRAFTS, { content: 'needle inside' })],
      folders: [], recent: [{ path: 'E:\\needle.md', name: 'needle.md', openedAt: 1 }],
      query: 'needle'
    })
    expect(groups.map((g) => g.id)).toEqual([DRAFTS, RECENT])
  })
})

describe('limits and recent cap', () => {
  it('constants match the Mac', () => {
    expect(MAX_FOLDERS).toBe(8)
    expect(MAX_RECENT).toBe(12)
    expect(MAX_EPHY_LINKS).toBe(500)
  })

  it('clampZoom stays within 80-140', () => {
    expect(clampZoom(10)).toBe(80)
    expect(clampZoom(500)).toBe(140)
    expect(clampZoom(100)).toBe(100)
  })

  it('rememberRecentEntries caps at max and puts fresh first', () => {
    const current = Array.from({ length: 12 }, (_, i) => ({ path: `E:\\f${i}.md`, name: `f${i}.md`, openedAt: i }))
    const next = rememberRecentEntries(current, [{ path: 'E:\\new.md', name: 'new.md' }], 99, MAX_RECENT)
    expect(next).toHaveLength(12)
    expect(next[0]).toEqual({ path: 'E:\\new.md', name: 'new.md', openedAt: 99 })
    expect(next.at(-1)!.path).toBe('E:\\f10.md')
  })

  it('rememberRecentEntries moves a re-opened file to the front without duplicating', () => {
    setPlatform('win32')
    const current = [
      { path: 'E:\\a.md', name: 'a.md', openedAt: 1 },
      { path: 'E:\\b.md', name: 'b.md', openedAt: 2 }
    ]
    const next = rememberRecentEntries(current, [{ path: 'e:/B.md', name: 'b.md' }], 9, MAX_RECENT)
    expect(next.map((e) => e.name)).toEqual(['b.md', 'a.md'])
    expect(next[0].openedAt).toBe(9)
  })
})

describe('restore merges with work done while it ran (finding 9)', () => {
  const folder = (path: string): FolderSource => ({ id: `folder:${path.toLowerCase()}`, name: path, path })
  it('keeps a folder added during the restore, after the restored ones, deduped and capped', () => {
    const restored = [folder('C:/A'), folder('C:/B')]
    const added = [folder('C:/C'), folder('c:/a'), folder('C:/B/inner')]
    setPlatform('win32')
    expect(mergeRestoredFolders(restored, added, MAX_FOLDERS).map((f) => f.path)).toEqual(['C:/A', 'C:/B', 'C:/C'])
    const many = Array.from({ length: MAX_FOLDERS + 2 }, (_, index) => folder(`D:/f${index}`))
    expect(mergeRestoredFolders(many.slice(0, 4), many.slice(4), MAX_FOLDERS)).toHaveLength(MAX_FOLDERS)
  })
  it('keeps a file opened during the restore at the top of Recent', () => {
    setPlatform('win32')
    const restored = [{ path: 'C:/old.md', name: 'old.md', openedAt: 1 }, { path: 'C:/new.md', name: 'new.md', openedAt: 0 }]
    const current = [{ path: 'c:/NEW.md', name: 'NEW.md', openedAt: 9 }]
    expect(mergeRestoredRecent(restored, current, MAX_RECENT)).toEqual([current[0], restored[0]])
    expect(mergeRestoredRecent(restored, [], 1)).toHaveLength(1)
  })
  it('a file opened ad hoc during the restore joins the restored folder that holds it', () => {
    setPlatform('win32')
    const source = folder('C:/Notes')
    const ad = toDoc({ name: 'a.md', path: 'C:/Notes/a.md', content: '', savedAt: 0 }, RECENT)
    const outside = toDoc({ name: 'b.md', path: 'D:/b.md', content: '', savedAt: 0 }, RECENT)
    const [adopted, kept] = adoptIntoFolders([ad, outside], [source])
    expect(adopted.sourceId).toBe(source.id)
    expect(kept.sourceId).toBe(RECENT)
  })
})
