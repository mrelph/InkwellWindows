import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { EphyClient } from './client'
import { EphyError } from './core'
import { buildEnvironment, cmdCommandLine, invocationFor, isSafeCmdPath, runProcess, sanitizeCmdArgument } from './launcher'

/* End to end through a real child process against the fake CLI in
   test/fake-ephy.mjs (run with this node). Never the real `ephy`. */

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fake-ephy.mjs')
const node = process.execPath

const runFake = (mode: string, args: string[], stdin?: string, timeoutMs = 10_000) =>
  runProcess(node, [fakeCli, `--fake-mode=${mode}`, ...args], stdin, timeoutMs)

describe('real process', () => {
  it('passes arguments verbatim and content on stdin', async () => {
    const result = await runFake('echo', ['a b', '$(id)', '--json', '%PATH%', 'x&y'], 'hello')
    expect(result?.status).toBe(0)
    expect(result?.timedOut).toBe(false)
    expect(result?.stdout).toBe('a b\n$(id)\n--json\n%PATH%\nx&y\nhello')
  })

  it('carries multi-byte content on stdin intact', async () => {
    const result = await runFake('echo', [], 'héllo — 日本語 🙂\r\nline2')
    expect(result?.stdout).toBe('héllo — 日本語 🙂\r\nline2')
  })

  it('a timeout kills the process and reports it', async () => {
    const start = Date.now()
    const result = await runFake('hang', [], undefined, 400)
    expect(result?.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(6000)
  })

  it('a child that ignores a large stdin does not crash Inkwell', async () => {
    const result = await runFake('ignorestdin', [], 'A'.repeat(4 << 20))
    expect(result?.status).toBe(3)
  })

  it('a missing executable is null', async () => {
    expect(await runProcess(path.join(os.tmpdir(), 'no-such-dir', 'ephy.exe'), [], undefined, 1000)).toBeNull()
  })

  it('uses a small fixed environment and a neutral working folder', async () => {
    const result = await runFake('env', [])
    const [noUpgrade, viaAgent, cwd] = (result?.stdout ?? '').split('|')
    expect(noUpgrade).toBe('1')
    expect(viaAgent).toBe('0')
    expect(path.resolve(cwd).toLowerCase()).toBe(path.resolve(os.homedir()).toLowerCase())
  })
})

describe('full client against the fake CLI', () => {
  const client = (mode: string) => new EphyClient({
    executable: node,
    launcher: (exe, args, stdin, timeout) => runProcess(exe, [fakeCli, `--fake-mode=${mode}`, ...args], stdin, timeout),
    isEnabled: () => true,
    timeoutMs: 10_000
  })
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return error instanceof EphyError ? error.code : 'other'
    }
    return 'none'
  }

  it('lists, gets, uploads, creates and opens', async () => {
    expect((await client('list').list()).artifacts).toHaveLength(2)
    expect((await client('get').get('aB3dK9xQ2mZp')).version).toBe(2)
    expect(await client('update').update('aB3dK9xQ2mZp', '# body', 5)).toBe(6)
    expect((await client('new').create('Plan', '# body')).id).toBe('Nn1Nn2Nn3Nn4')
    expect(await client('open').viewerUrl('aB3dK9xQ2mZp')).toBe('https://ephy.example.com/aB3dK9xQ2mZp/notes')
  })

  it('a stale base version is a conflict; a signed-out session says so; a hang times out', async () => {
    expect(await code(() => client('update').update('aB3dK9xQ2mZp', 'x', 1))).toBe('conflict')
    expect(await code(() => client('signedout').list())).toBe('signedOut')
    const quick = new EphyClient({
      executable: node,
      launcher: (exe, args, stdin, timeout) => runProcess(exe, [fakeCli, '--fake-mode=hang', ...args], stdin, timeout),
      isEnabled: () => true,
      timeoutMs: 400
    })
    expect(await code(() => quick.list())).toBe('timedOut')
  })
})

describe('cmd shims', () => {
  it('quotes the whole line for cmd /s /c and strips what cmd would act on', () => {
    expect(cmdCommandLine('C:\\T o\\ephy.cmd', ['post', 'list', '--json'])).toBe('""C:\\T o\\ephy.cmd" "post" "list" "--json""')
    expect(sanitizeCmdArgument('a&b|c<d>e^f%g"h!i')).toBe('a b c d e f g h i')
    expect(sanitizeCmdArgument('Plan 2026: notes (v2)')).toBe('Plan 2026: notes (v2)')
    expect(isSafeCmdPath('C:\\Users\\me\\.toolbox\\bin\\ephy.cmd')).toBe(true)
    expect(isSafeCmdPath('C:\\a&b\\ephy.cmd')).toBe(false)
    expect(isSafeCmdPath('C:\\%TEMP%\\ephy.cmd')).toBe(false)
  })

  it('only routes .cmd and .bat through cmd.exe, and only on Windows', () => {
    expect(invocationFor('C:\\x\\ephy.exe', ['a'], 'win32')).toEqual({ file: 'C:\\x\\ephy.exe', args: ['a'], verbatim: false })
    const shim = invocationFor('C:\\x\\ephy.cmd', ['a'], 'win32')
    expect(shim?.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(shim?.verbatim).toBe(true)
    expect(invocationFor('C:\\x\\ephy.CMD', ['a'], 'win32')?.verbatim).toBe(true)
    expect(invocationFor('C:\\a&b\\ephy.cmd', ['a'], 'win32')).toBeNull()
    expect(invocationFor('/x/ephy.cmd', ['a'], 'linux')).toEqual({ file: '/x/ephy.cmd', args: ['a'], verbatim: false })
  })

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ephy-shim-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.runIf(process.platform === 'win32')('runs a real .cmd shim with args and stdin', async () => {
    const shim = path.join(dir, 'ephy.cmd')
    writeFileSync(shim, `@echo off\r\n"${node}" "${fakeCli}" --fake-mode=echo %*\r\n`)
    const result = await runProcess(shim, ['post', 'x y', 'a&calc|b', '--json'], 'body text', 15_000)
    expect(result?.status).toBe(0)
    // The & and | were replaced, never run; the rest arrives as separate arguments.
    expect(result?.stdout).toBe('post\nx y\na calc b\n--json\nbody text')
  })
})

describe('environment', () => {
  it('whitelists, puts the CLI folder first on PATH and tags the run', () => {
    const env = buildEnvironment('C:\\Tools\\ephy.exe', { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', SECRET_TOKEN: 'x', SystemRoot: 'C:\\Windows' }, 'win32')
    expect(env.Path).toBe('C:\\Tools;C:\\Windows')
    expect(env.USERPROFILE).toBe('C:\\Users\\me')
    expect(env.HOME).toBe('C:\\Users\\me')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.EPHY_NO_UPGRADE_CHECK).toBe('1')
    expect(env.EPHY_VIA_AGENT).toBe('0')
  })
})
