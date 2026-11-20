import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* Finding 2 for the agent sandbox: a UNC path from an agent (or a renderer)
   must be refused LEXICALLY — before realpath/stat/lstat, any of which would
   make Windows connect to that server and offer the user's NTLM hash. The
   whole `node:fs` surface the sandbox uses is instrumented here. */

const spy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const record = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
    ((...args: Parameters<T>) => {
      spy.calls.push(`${name} ${String(args[0])}`)
      return fn(...args)
    }) as T
  const realpathSync = Object.assign(record('realpathSync', actual.realpathSync), {
    native: record('realpathSync.native', actual.realpathSync.native)
  })
  const lstatSync = record('lstatSync', actual.lstatSync)
  const statSync = record('statSync', actual.statSync)
  const overrides = { realpathSync, lstatSync, statSync }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

const { PathSandbox } = await import('./pathSandbox')
const { AgentFileAccess } = await import('./fileAccess')

const root = mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-unc-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => { spy.calls = [] })

const UNC = [
  '\\\\attacker\\share\\x.md',
  '//attacker/share/x.md',
  '\\\\attacker@SSL\\DavWWWRoot\\notes\\x.md',
  '\\\\attacker.example\\c$\\x.md'
]

describe('PathSandbox never touches a UNC path the roots do not cover', () => {
  it('refuses with no fs call for the path', () => {
    const box = new PathSandbox([root], { windows: true, home: nodePath.join(root, 'nohome') })
    spy.calls = []
    for (const path of UNC) expect(box.resolve(path)).toEqual({ ok: false, denial: 'outside' })
    expect(spy.calls.filter((call) => /attacker/i.test(call))).toEqual([])
    expect(spy.calls).toEqual([])
  })
  it('device paths are not absolute at all', () => {
    const box = new PathSandbox([root], { windows: true, home: nodePath.join(root, 'nohome') })
    spy.calls = []
    expect(box.resolve('\\\\?\\UNC\\attacker\\share\\x.md')).toEqual({ ok: false, denial: 'notAbsolute' })
    expect(box.resolve('\\\\.\\UNC\\attacker\\share\\x.md')).toEqual({ ok: false, denial: 'notAbsolute' })
    expect(spy.calls).toEqual([])
  })
  it('an agent read of a UNC path is refused by Inkwell before any fs call', async () => {
    const access = new AgentFileAccess({
      sandbox: () => new PathSandbox([root], { windows: true, home: nodePath.join(root, 'nohome') }),
      openBuffer: async () => null,
      applyToBuffer: async () => false,
      confirmWrite: async () => true
    })
    spy.calls = []
    await expect(access.read('\\\\attacker\\share\\secret.md')).rejects.toMatchObject({ data: { refusedBy: 'inkwell' } })
    await expect(access.write('\\\\attacker\\share\\x.md', 'x')).rejects.toMatchObject({ data: { refusedBy: 'inkwell' } })
    expect(spy.calls.filter((call) => /attacker/i.test(call))).toEqual([])
  })
})
