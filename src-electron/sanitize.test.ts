import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  nativeTheme: { shouldUseDarkColors: true, on: () => {}, removeListener: () => {} }
}))

const abs = (...parts: string[]) => path.join(os.tmpdir(), 'inkwell-abs', ...parts)

beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'inkwell-sanitize-'))
  vi.resetModules()
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

const loadWith = async (raw: string | object | undefined) => {
  if (raw !== undefined) {
    await writeFile(path.join(userData, 'library.json'), typeof raw === 'string' ? raw : JSON.stringify(raw))
  }
  const { loadState } = await import('./state')
  return loadState()
}

const DEFAULT = { folders: [], recent: [], readerFont: 'editorial', zoomLevel: 100, view: 'split', ephyLinks: {} }

describe('state.ts sanitize-on-load', () => {
  it('returns defaults when there is no file', async () => {
    expect(await loadWith(undefined)).toMatchObject(DEFAULT)
  })

  it.each(['', '{', 'not json', '[1,2,3]', 'null', '42', '"str"', 'true', '\u0000\u0001', '{"folders": [}'])(
    'garbage %j yields defaults without throwing',
    async (raw) => {
      expect(await loadWith(raw)).toMatchObject(DEFAULT)
    }
  )

  it('wrong types fall back per field', async () => {
    const state = await loadWith({
      folders: 'nope', recent: 5, activePath: 7, readerFont: 3, zoomLevel: 'big', view: {}, ephyLinks: []
    })
    expect(state).toMatchObject(DEFAULT)
    expect(state.activePath).toBeUndefined()
  })

  it('keeps only absolute string folders and caps at 8', async () => {
    const folders = [...Array.from({ length: 12 }, (_, i) => abs(`f${i}`)), 'relative/dir', 5, null]
    const state = await loadWith({ folders })
    expect(state.folders).toHaveLength(8)
    expect(state.folders).toEqual(Array.from({ length: 8 }, (_, i) => abs(`f${i}`)))
    expect((await loadWith({ folders: ['rel', './x', 4] })).folders).toEqual([])
  })

  it('recent: validates entries, fills defaults and caps at 12', async () => {
    const recent = [
      { path: abs('a.md'), name: 'a.md', openedAt: 5 },
      { path: abs('b.md') },
      { path: 'relative.md', name: 'r' },
      { name: 'nopath' },
      'string',
      null,
      { path: abs('c.md'), name: 9, openedAt: 'x' },
      ...Array.from({ length: 20 }, (_, i) => ({ path: abs(`n${i}.md`), name: `n${i}`, openedAt: i }))
    ]
    const state = await loadWith({ recent })
    expect(state.recent).toHaveLength(12)
    expect(state.recent[0]).toEqual({ path: abs('a.md'), name: 'a.md', openedAt: 5 })
    expect(state.recent[1]).toEqual({ path: abs('b.md'), name: 'b.md', openedAt: 0 })
    expect(state.recent[2]).toEqual({ path: abs('c.md'), name: 'c.md', openedAt: 0 })
  })

  it('view accepts only read/split/write', async () => {
    for (const view of ['read', 'split', 'write']) expect((await loadWith({ view })).view).toBe(view)
    for (const view of ['READ', 'focus', '', null, 1, ['read']]) expect((await loadWith({ view })).view).toBe('split')
  })

  it('readerFont accepts only known fonts', async () => {
    for (const readerFont of ['editorial', 'classic', 'sans', 'system', 'mono']) {
      expect((await loadWith({ readerFont })).readerFont).toBe(readerFont)
    }
    expect((await loadWith({ readerFont: 'comic' })).readerFont).toBe('editorial')
  })

  it('zoom snaps to steps of 10 and clamps to 80-140', async () => {
    const zoom = async (zoomLevel: unknown) => (await loadWith({ zoomLevel })).zoomLevel
    expect(await zoom(1000)).toBe(140)
    expect(await zoom(-5)).toBe(80)
    expect(await zoom(114)).toBe(110)
    expect(await zoom(116)).toBe(120)
    expect(await zoom(NaN)).toBe(100)
    expect(await zoom(null)).toBe(100)
    expect(await zoom('120')).toBe(100)
  })

  it('drops unknown fields', async () => {
    const state = await loadWith({ introDone: true, evil: { x: 1 }, folders: [abs('a')] })
    expect(Object.keys(state).sort()).toEqual(
      ['activePath', 'ephyLinks', 'folders', 'readerFont', 'recent', 'view', 'zoomLevel'].sort()
    )
  })

  it('keeps a string activePath', async () => {
    expect((await loadWith({ activePath: abs('x.md') })).activePath).toBe(abs('x.md'))
  })

  it('survives deeply hostile structures', async () => {
    const hostile = { folders: [{}], recent: [{ path: {} }, { path: [] }], ephyLinks: { [abs('a')]: { id: {} } }, view: [] }
    expect(await loadWith(hostile)).toMatchObject(DEFAULT)
  })
})

describe('state.ts ephyLinks', () => {
  const links = async (ephyLinks: unknown) => (await loadWith({ ephyLinks })).ephyLinks

  it('accepts a valid link and keeps version', async () => {
    expect(await links({ [abs('a.md')]: { id: 'abc123', title: 'Hello', version: 3 } })).toEqual({
      [abs('a.md')]: { id: 'abc123', title: 'Hello', version: 3 }
    })
  })

  it('accepts the Mac artifactId spelling', async () => {
    expect(await links({ [abs('a.md')]: { artifactId: 'Mac12345', title: 'T' } })).toEqual({
      [abs('a.md')]: { id: 'Mac12345', title: 'T' }
    })
  })

  it('id wins over artifactId when both are present and id is valid', async () => {
    const result = await links({ [abs('a.md')]: { id: 'goodid1', artifactId: 'otherid2', title: 'T' } })
    expect(result[abs('a.md')].id).toBe('goodid1')
  })

  it('drops relative-path keys', async () => {
    expect(await links({ 'notes/a.md': { id: 'abc123', title: 'T' }, 'a.md': { id: 'abc123', title: 'T' } })).toEqual({})
  })

  it('enforces the id regex ^[A-Za-z0-9]{6,40}$', async () => {
    const ok = ['abcdef', 'A1B2C3', 'x'.repeat(40)]
    const bad = ['abcde', 'x'.repeat(41), '-flag12', 'has space', 'under_score', 'dash-ed1', '', 5, null, 'été1234', 'abc123\n']
    for (const id of ok) expect(Object.keys(await links({ [abs('a.md')]: { id, title: 't' } })), String(id)).toHaveLength(1)
    for (const id of bad) expect(Object.keys(await links({ [abs('a.md')]: { id, title: 't' } })), String(id)).toHaveLength(0)
  })

  it('cleans titles: single line, leading dashes stripped, 200 cap, default', async () => {
    const title = async (value: unknown) => (await links({ [abs('a.md')]: { id: 'abc123', title: value } }))[abs('a.md')].title
    expect(await title('line one\nline two')).toBe('line one line two')
    expect(await title('--flag')).toBe('flag')
    expect(await title('x'.repeat(500))).toHaveLength(200)
    expect(await title('')).toBe('Untitled note')
    expect(await title(undefined)).toBe('Untitled note')
    expect(await title(42)).toBe('Untitled note')
    expect(await title('---')).toBe('Untitled note')
  })

  it('version must be a non-negative integer', async () => {
    const version = async (value: unknown) => (await links({ [abs('a.md')]: { id: 'abc123', title: 't', version: value } }))[abs('a.md')]
    expect(await version(0)).toHaveProperty('version', 0)
    expect(await version(-1)).not.toHaveProperty('version')
    expect(await version(1.5)).not.toHaveProperty('version')
    expect(await version('2')).not.toHaveProperty('version')
    expect(await version(null)).not.toHaveProperty('version')
  })

  it('drops non-object entries', async () => {
    expect(await links({ [abs('a.md')]: 'x', [abs('b.md')]: null, [abs('c.md')]: [1] })).toEqual({})
  })

  it('caps at 500 links', async () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 600; i += 1) many[abs(`n${String(i).padStart(4, '0')}.md`)] = { id: 'abc123', title: `t${i}` }
    expect(Object.keys(await links(many))).toHaveLength(500)
  })

  it('ignores extra fields on an entry', async () => {
    const result = await links({ [abs('a.md')]: { id: 'abc123', title: 't', content: 'SECRET', x: 1 } })
    expect(result[abs('a.md')]).toEqual({ id: 'abc123', title: 't' })
  })
})

describe('state.ts saveState', () => {
  it('round-trips through sanitize and never throws on garbage', async () => {
    const { saveState, loadState } = await import('./state')
    await expect(saveState(undefined)).resolves.toBeUndefined()
    await expect(saveState({ folders: 3 })).resolves.toBeUndefined()
    await saveState({ folders: [abs('a')], view: 'write', zoomLevel: 123, junk: 1 })
    const state = await loadState()
    expect(state).toMatchObject({ folders: [abs('a')], view: 'write', zoomLevel: 120 })
    const onDisk = JSON.parse(await readFile(path.join(userData, 'library.json'), 'utf8'))
    expect(onDisk.junk).toBeUndefined()
  })

  it('does not throw when userData is unwritable', async () => {
    const blocker = path.join(userData, 'file')
    await writeFile(blocker, 'x')
    const previous = userData
    userData = path.join(blocker, 'nested')
    const { saveState } = await import('./state')
    await expect(saveState({})).resolves.toBeUndefined()
    userData = previous
  })
})

describe('settings.ts sanitize-on-load', () => {
  const load = async (raw: string | object | undefined) => {
    if (raw !== undefined) await writeFile(path.join(userData, 'settings.json'), typeof raw === 'string' ? raw : JSON.stringify(raw))
    const { getSettings } = await import('./settings')
    return getSettings()
  }
  const DEFAULTS = {
    agentEnabled: false, agentHarness: 'kiro', agentIncludeNote: true, ephyEnabled: false, autoUpdateCheck: true, spellcheck: true
  }

  it('defaults when missing', async () => {
    expect(await load(undefined)).toEqual(DEFAULTS)
  })

  it.each(['', '{', 'garbage', '[]', 'null', '7'])('garbage %j yields defaults', async (raw) => {
    expect(await load(raw)).toEqual(DEFAULTS)
  })

  it('wrong types fall back per key', async () => {
    expect(await load({
      agentEnabled: 'yes', agentHarness: 5, agentIncludeNote: 0, ephyEnabled: 1, autoUpdateCheck: null, spellcheck: 'false'
    })).toEqual(DEFAULTS)
  })

  it('keeps valid booleans', async () => {
    expect(await load({ agentEnabled: true, agentIncludeNote: false, ephyEnabled: true, autoUpdateCheck: false, spellcheck: false }))
      .toMatchObject({ agentEnabled: true, agentIncludeNote: false, ephyEnabled: true, autoUpdateCheck: false, spellcheck: false })
  })

  it('agentHarness only kiro/codex/claude', async () => {
    for (const h of ['kiro', 'codex', 'claude']) {
      vi.resetModules()
      expect((await load({ agentHarness: h })).agentHarness).toBe(h)
    }
    vi.resetModules()
    expect((await load({ agentHarness: 'gemini' })).agentHarness).toBe('kiro')
  })

  it('drops unknown keys', async () => {
    expect(Object.keys(await load({ evil: 1, spellcheck: false })).sort()).toEqual(Object.keys(DEFAULTS).sort())
  })

  it('setSetting updates memory, validates, and persists', async () => {
    const { setSetting, getSetting } = await import('./settings')
    expect(setSetting('ephyEnabled', true)).toBe(true)
    expect(getSetting('ephyEnabled')).toBe(true)
    expect(setSetting('agentHarness', 'bogus' as never)).toBe('kiro')
    await vi.waitFor(async () => {
      const disk = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'))
      expect(disk.ephyEnabled).toBe(true)
    })
  })

  it('does not throw when the settings path is unreadable (a directory)', async () => {
    await mkdir(path.join(userData, 'settings.json'))
    const { getSettings } = await import('./settings')
    expect(getSettings()).toEqual(DEFAULTS)
  })
})
