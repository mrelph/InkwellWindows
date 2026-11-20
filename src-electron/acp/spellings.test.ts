import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentController, type AgentEnvironment, type BufferAnswer, type BufferQuery } from './controller'
import { canonical } from './pathSandbox'
import { PathSpellings } from './spellings'

/* Finding 13: an open note reached through a directory junction (or a mapped
   drive, a short name) must route the agent's reads and writes to its BUFFER,
   whether or not it is the active note. `fs.symlinkSync(…, 'junction')` needs
   no admin rights. */

const fakeAgent = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'test', 'fakeAgent.mjs')
const base = canonical(mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-junction-'))) as string
afterAll(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
/** A real folder and a junction to it: [real, link]. */
function junctioned(): [string, string] {
  const real = nodePath.join(base, `real${counter}`)
  const link = nodePath.join(base, `link${counter}`)
  counter += 1
  mkdirSync(real, { recursive: true })
  symlinkSync(real, link, 'junction')
  return [real, link]
}

const windows = process.platform === 'win32'
const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)

describe('PathSpellings', () => {
  it('maps every open note, not only the active one, back to the renderer spelling', () => {
    const [real, link] = junctioned()
    for (const name of ['active.md', 'other.md']) writeFileSync(nodePath.join(real, name), name)
    const spellings = new PathSpellings(canonical)
    spellings.update([nodePath.join(link, 'active.md'), nodePath.join(link, 'other.md')], [link])
    expect(spellings.toRenderer(nodePath.join(real, 'other.md'))).toBe(nodePath.join(link, 'other.md'))
    expect(spellings.toRenderer(nodePath.join(real, 'active.md'))).toBe(nodePath.join(link, 'active.md'))
    expect(spellings.noteFor(nodePath.join(real, 'missing.md'))).toBeNull()
  })
  it('reports a new file in a library folder under the renderer spelling of that folder', () => {
    const [real, link] = junctioned()
    const spellings = new PathSpellings(canonical)
    spellings.update([], [link])
    expect(spellings.toRenderer(nodePath.join(real, 'sub', 'new.md'))).toBe(nodePath.join(link, 'sub', 'new.md'))
    expect(spellings.toRenderer(nodePath.join(base, 'elsewhere.md'))).toBe(nodePath.join(base, 'elsewhere.md'))
  })
  it('matches case-insensitively on Windows and needs no disk for a lexical match', () => {
    const calls: string[] = []
    const spellings = new PathSpellings((p) => { calls.push(p); return p }, true)
    spellings.update(['C:\\Notes\\A.md'], ['C:\\Notes'])
    expect(spellings.toRenderer('c:\\notes\\a.md')).toBe('C:\\Notes\\A.md')
    expect(spellings.toRenderer('c:\\NOTES\\b.md')).toBe('C:\\Notes\\b.md')
  })
})

describe('agent end to end through a junction', () => {
  it('a write to a NON-active open note reached through a junction goes to its buffer, not the disk', async () => {
    const [real, link] = junctioned()
    const target = nodePath.join(real, 'other.md')
    writeFileSync(target, 'on disk')
    writeFileSync(nodePath.join(real, 'active.md'), 'active')
    /* The renderer opened both notes through the junction; its buffers are
       keyed by ITS spelling, as App's documents are (samePath). */
    const rendererOther = nodePath.join(link, 'other.md')
    const buffers = new Map<string, string>([[rendererOther, 'unsaved text']])
    const spellings = new PathSpellings(canonical)
    const queries: BufferQuery[] = []
    const written: string[] = []
    const env: AgentEnvironment = {
      isEnabled: () => true,
      getHarness: () => 'kiro',
      emit: () => undefined,
      askPermission: async (prompt) => prompt.options.find((o) => o.kind === 'allow_once')?.optionId ?? null,
      /* What acp/index.ts does: translate to the renderer's spelling, which
         the renderer then matches exactly. */
      askBuffer: async (query): Promise<BufferAnswer> => {
        const spelled = query.draft ? query.path : spellings.toRenderer(query.path)
        queries.push({ ...query, path: spelled })
        const key = [...buffers.keys()].find((entry) => same(entry, spelled))
        if (!key) return { open: false }
        if (query.op === 'read') return { open: true, content: buffers.get(key) as string }
        buffers.set(key, query.content)
        return { open: true, applied: true }
      },
      onFileWritten: (path) => written.push(spellings.toRenderer(path)),
      fallbackDirectory: () => nodePath.join(base, 'fallback'),
      home: nodePath.join(base, 'no-such-home'),
      flushMs: 5,
      prepareLaunch: async (_harness, cwd) => ({
        command: process.execPath,
        args: [fakeAgent],
        cwd,
        env: { ...(process.env as Record<string, string>), FAKE_ACP_TARGET: target },
        title: 'Fake'
      })
    }
    const controller = new AgentController(env)
    const context = { roots: [link], activePath: nodePath.join(link, 'active.md'), openPaths: [nodePath.join(link, 'active.md'), rendererOther] }
    spellings.update(context.openPaths, context.roots)
    controller.setContext(context)
    expect(await controller.newSession()).toEqual({ ok: true })
    await controller.prompt({ text: 'Edit it', includeNote: false })
    expect(buffers.get(rendererOther)).toBe('unsaved text\nSummary: added by the fake agent.\n')
    expect(readFileSync(target, 'utf8')).toBe('on disk')
    expect(queries.every((query) => same(query.path, rendererOther))).toBe(true)
    expect(written).toEqual([])
    await controller.stop()
  })
})
