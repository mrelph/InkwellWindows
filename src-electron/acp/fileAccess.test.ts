import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentFileAccess, isNoFolders, slice, type FileAccessHost, type WriteRequest } from './fileAccess'
import { createNotesFolder, defaultNotesFolderPath } from './notesFolder'
import { RPC, RPCError } from './jsonrpc'
import { canonical, PathSandbox } from './pathSandbox'
import { safestOption } from './client'

const base = mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-files-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let counter = 0
const folder = () => {
  const dir = nodePath.join(base, `case${counter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const nowhere = { home: nodePath.join(base, 'no-such-home') }

type Calls = { confirms: WriteRequest[]; applied: Array<[string, string]>; created: Array<[string, boolean]> }

function access(root: string, options: { allow?: boolean; buffers?: Record<string, string>; files?: string[]; roots?: string[] } = {}) {
  const calls: Calls = { confirms: [], applied: [], created: [] }
  const buffers = new Map(Object.entries(options.buffers ?? {}).map(([path, text]) => [canonical(path) ?? path, text]))
  const host: FileAccessHost = {
    sandbox: () => new PathSandbox(options.roots ?? [root], { files: options.files, ...nowhere }),
    openBuffer: async (path) => buffers.get(path) ?? null,
    applyToBuffer: async (path, text) => { calls.applied.push([path, text]); buffers.set(path, text); return true },
    confirmWrite: async (request) => { calls.confirms.push(request); return options.allow ?? true },
    didWriteFile: (path, created) => calls.created.push([path, created])
  }
  return { files: new AgentFileAccess(host), calls, buffers }
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RPCError)
    return error as RPCError
  }
  throw new Error('expected a rejection')
}

describe('AgentFileAccess', () => {
  it('a denied write leaves the file alone and says the user refused', async () => {
    const root = folder()
    writeFileSync(nodePath.join(root, 'a.md'), 'old')
    const { files, calls } = access(root, { allow: false })
    const error = await rejection(files.write(nodePath.join(root, 'a.md'), 'new'))
    expect(error.data).toEqual({ refusedBy: 'user' })
    expect(calls.confirms).toHaveLength(1)
    expect(calls.confirms[0]).toMatchObject({ old: 'old', new: 'new', openNote: false, creates: false })
    expect(readFileSync(nodePath.join(root, 'a.md'), 'utf8')).toBe('old')
  })

  it('an allowed write goes to disk atomically and a new file previews as all added', async () => {
    const root = folder()
    const { files, calls } = access(root)
    await files.write(nodePath.join(root, 'fresh.md'), 'hello')
    expect(readFileSync(nodePath.join(root, 'fresh.md'), 'utf8')).toBe('hello')
    expect(calls.confirms[0]).toMatchObject({ old: '', creates: true })
    expect(readdirSync(root)).toEqual(['fresh.md']) // no temp file left behind
    await files.write(nodePath.join(root, 'fresh.md'), 'hello 2')
    expect(calls.created.map(([, created]) => created)).toEqual([true, false])
  })

  it('writes outside the sandbox never ask', async () => {
    const root = folder()
    const other = folder()
    const { files, calls } = access(root)
    const error = await rejection(files.write(nodePath.join(other, 'x.md'), 'x'))
    expect(error.data).toMatchObject({ refusedBy: 'inkwell' })
    expect(error.message).toContain('outside the folders Inkwell shares')
    expect(calls.confirms).toEqual([])
    expect(existsSync(nodePath.join(other, 'x.md'))).toBe(false)
  })

  it('refuses hidden files and folders as paths, with the reason', async () => {
    const root = folder()
    const { files, calls } = access(root)
    const error = await rejection(files.write(nodePath.join(root, '.env'), 'KEY=1'))
    expect(error.message).toBe('Hidden files and folders are off limits')
    expect(calls.confirms).toEqual([])
  })

  it('open notes are read from and written to their buffer, never the disk', async () => {
    const root = folder()
    const path = nodePath.join(root, 'open.md')
    writeFileSync(path, 'on disk')
    const { files, calls } = access(root, { buffers: { [path]: 'unsaved\nsecond\nthird' } })
    expect(await files.read(path)).toBe('unsaved\nsecond\nthird')
    expect(await files.read(path, 2, 1)).toBe('second')
    await files.write(path, 'edited')
    expect(calls.confirms[0]).toMatchObject({ old: 'unsaved\nsecond\nthird', openNote: true })
    expect(calls.applied).toEqual([[canonical(path), 'edited']])
    expect(readFileSync(path, 'utf8')).toBe('on disk')
  })

  it('a missing file is "not found", which is routine', async () => {
    const root = folder()
    const { files } = access(root)
    const error = await rejection(files.read(nodePath.join(root, 'nope.md')))
    expect(error.code).toBe(RPC.resourceNotFound)
    expect(error.message).toBe('File not found')
  })

  it('reads a real file, and refuses non-UTF-8 and folders', async () => {
    const root = folder()
    writeFileSync(nodePath.join(root, 'a.md'), 'one\ntwo')
    writeFileSync(nodePath.join(root, 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x80]))
    mkdirSync(nodePath.join(root, 'dir'))
    const { files } = access(root)
    expect(await files.read(nodePath.join(root, 'a.md'))).toBe('one\ntwo')
    expect((await rejection(files.read(nodePath.join(root, 'bin.md')))).message).toBe('That is not a UTF-8 text file')
    expect((await rejection(files.read(nodePath.join(root, 'dir')))).code).toBe(RPC.resourceNotFound)
    expect((await rejection(files.write(nodePath.join(root, 'dir'), 'x'))).message).toBe('That path is a folder')
  })

  it('with no shared folders it says so and never asks', async () => {
    const { files, calls } = access('', { roots: [] })
    const error = await rejection(files.write(nodePath.join(base, 'Ideas.md'), '# Ideas'))
    expect(error.message.startsWith('No notes folder is shared yet')).toBe(true)
    expect(error.message).toContain('Do not invent a path')
    expect(error.data).toMatchObject({ refusedBy: 'inkwell', reason: 'noFolders' })
    expect(isNoFolders(error)).toBe(true)
    expect(calls.confirms).toEqual([])
  })

  it('an unsaved note\'s writes go to its buffer only, and a closed draft is refused without a sheet', async () => {
    const root = folder()
    const virtual = nodePath.join(canonical(root) as string, 'Untitled note.md')
    const { files, calls, buffers } = access('', { roots: [], files: [virtual], buffers: {} })
    buffers.set(virtual, '# Untitled note')
    expect(await files.read(virtual)).toBe('# Untitled note')
    await files.write(virtual, '# Plan\n')
    expect(buffers.get(virtual)).toBe('# Plan\n')
    expect(calls.confirms).toHaveLength(1)
    expect(existsSync(virtual)).toBe(false)

    buffers.delete(virtual)
    await rejection(files.write(virtual, 'x'))
    expect(calls.confirms).toHaveLength(1)
    expect(existsSync(virtual)).toBe(false)
  })

  it('a note saved or closed while the sheet was up is not written to disk', async () => {
    const root = folder()
    const path = nodePath.join(canonical(root) as string, 'note.md')
    const buffers = new Map<string, string>([[path, 'draft']])
    const files = new AgentFileAccess({
      sandbox: () => new PathSandbox([root], nowhere),
      openBuffer: async (p) => buffers.get(p) ?? null,
      applyToBuffer: async () => true,
      confirmWrite: async () => { buffers.delete(path); return true }
    })
    await rejection(files.write(path, 'agent text'))
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a write that is too large before asking', async () => {
    const root = folder()
    const { files, calls } = access(root)
    await rejection(files.write(nodePath.join(root, 'big.md'), 'x'.repeat(8 * 1024 * 1024 + 1)))
    expect(calls.confirms).toEqual([])
  })
})

describe('slice and permission helpers', () => {
  it('slices by 1-based line and count', () => {
    expect(slice('a\nb\nc', 2, 1)).toBe('b')
    expect(slice('a\nb\nc', 2)).toBe('b\nc')
    expect(slice('a\nb\nc', undefined, 2)).toBe('a\nb')
    expect(slice('a\nb', 9)).toBe('')
    expect(slice('a\nb')).toBe('a\nb')
  })

  it('the safest option is a reject, else nothing', () => {
    const options = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'ra', name: 'Never', kind: 'reject_always' },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' }
    ]
    expect(safestOption(options)?.optionId).toBe('r')
    expect(safestOption([options[0]])).toBeUndefined()
  })
})

/* Issue #29: offer a notes folder when the agent has nowhere to save. A fake
   library whose folders the offer can fill, like "Create" does. */
describe('notes folder offer (issue #29)', () => {
  type Library = { roots: string[]; offers: string[]; confirms: string[] }

  function offering(library: Library, options: { buffers?: Record<string, string>; offer: (library: Library) => boolean }) {
    const buffers = new Map(Object.entries(options.buffers ?? {}).map(([path, text]) => [canonical(path) ?? path, text]))
    return new AgentFileAccess({
      sandbox: () => new PathSandbox(library.roots, nowhere),
      openBuffer: async (path) => buffers.get(path) ?? null,
      applyToBuffer: async () => true,
      confirmWrite: async (request) => { library.confirms.push(request.path); return true },
      offerNotesFolder: async (path) => { library.offers.push(path); return options.offer(library) }
    })
  }
  const emptyLibrary = (): Library => ({ roots: [], offers: [], confirms: [] })

  it('no folders and a create: offers, then retries once through the confirm', async () => {
    const home = folder() // a fake documents folder, never the real one
    const target = defaultNotesFolderPath(nodePath.join(home, 'Documents'))
    const library = emptyLibrary()
    const files = offering(library, {
      offer: (lib) => {
        const real = createNotesFolder(target)
        if (!real) return false
        lib.roots = [real]
        return true
      }
    })
    await files.write(nodePath.join(target, 'Ideas.md'), '# Ideas')
    expect(library.offers).toHaveLength(1)
    expect(library.confirms).toHaveLength(1) // the retry still asks Allow Once
    expect(readFileSync(nodePath.join(target, 'Ideas.md'), 'utf8')).toBe('# Ideas')
  })

  it('a missing folder under a made-up path is the same offer, and a retry never offers again', async () => {
    const home = folder()
    const library = emptyLibrary()
    // The folder is added, but the agent's path is still outside it.
    const files = offering(library, {
      offer: (lib) => {
        lib.roots = [createNotesFolder(defaultNotesFolderPath(nodePath.join(home, 'Documents'))) as string]
        return true
      }
    })
    const error = await rejection(files.write(nodePath.join(folder(), 'nested', 'Ideas.md'), 'x'))
    expect(isNoFolders(error)).toBe(false) // the retry's refusal names the shared folders instead
    expect(library.offers).toHaveLength(1)
    expect(library.confirms).toEqual([])
  })

  it('with a folder shared it never offers', async () => {
    const root = folder()
    const library: Library = { roots: [root], offers: [], confirms: [] }
    const files = offering(library, { offer: () => { throw new Error('no offer with a folder') } })
    await files.write(nodePath.join(root, 'a.md'), 'a')
    await rejection(files.write(nodePath.join(folder(), 'b.md'), 'b'))
    expect(library.offers).toEqual([])
  })

  it('Not Now refuses with the declined message and writes nothing', async () => {
    const home = folder()
    const target = defaultNotesFolderPath(nodePath.join(home, 'Documents'))
    const library = emptyLibrary()
    const files = offering(library, { offer: () => false })
    const error = await rejection(files.write(nodePath.join(target, 'Ideas.md'), '# Ideas'))
    expect(isNoFolders(error)).toBe(true)
    expect(error.message).toContain('chose not to add one')
    expect(library.offers).toHaveLength(1)
    expect(library.confirms).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  it('edits to an existing file or an open note never offer', async () => {
    const elsewhere = folder()
    writeFileSync(nodePath.join(elsewhere, 'old.md'), 'old')
    const openPath = nodePath.join(folder(), 'open.md')
    const library = emptyLibrary()
    const files = offering(library, { buffers: { [openPath]: 'open' }, offer: () => { throw new Error('edits never offer') } })
    expect(isNoFolders(await rejection(files.write(nodePath.join(elsewhere, 'old.md'), 'new')))).toBe(true)
    // An open note's buffer is keyed by its real path; its folder exists, so
    // the refusal is plain "outside" and nothing is offered either way.
    await rejection(files.write(openPath, 'new'))
    expect(library.offers).toEqual([])
  })

  it('a network path is not a create, so it never offers and is never touched', async () => {
    const library = emptyLibrary()
    const files = offering(library, { offer: () => { throw new Error('no offer for a network path') } })
    const error = await rejection(files.write(String.raw`\\attacker\share\Ideas.md`, 'x'))
    if (process.platform === 'win32') expect(isNoFolders(error)).toBe(true)
    expect(library.offers).toEqual([])
  })
})

describe('notes folder helper', () => {
  it('names Documents\Inkwell, makes it once and keeps an existing one', () => {
    const home = folder()
    const target = defaultNotesFolderPath(nodePath.join(home, 'Documents'))
    expect(nodePath.basename(target)).toBe('Inkwell')
    expect(nodePath.basename(nodePath.dirname(target))).toBe('Documents')
    const made = createNotesFolder(target)
    expect(made).not.toBeNull()
    writeFileSync(nodePath.join(target, 'keep.md'), 'keep')
    expect(createNotesFolder(target)).toBe(made)
    expect(existsSync(nodePath.join(target, 'keep.md'))).toBe(true)
    writeFileSync(nodePath.join(home, 'blocked'), 'a file')
    expect(createNotesFolder(nodePath.join(home, 'blocked'))).toBeNull() // a file in the way
  })

  it('refuses a network path without touching it', () => {
    if (process.platform !== 'win32') return
    expect(createNotesFolder(String.raw`\\attacker\share\Inkwell`)).toBeNull()
  })
})
