import { describe, expect, it } from 'vitest'
import { EphyClient } from './client'
import { EphyError } from './core'
import type { Launcher, RunResult } from './launcher'
import { listJSON } from './test/fixtures'

/* Port of EphyClientTests, EphyLinkTests and the client half of
   EphyGetLatestTests. The launcher is a fake that records every launch. */

type Call = { args: readonly string[]; stdin: string | undefined }

function fake(stdout = '{}', extra: Partial<RunResult> = {}, missing = false) {
  const calls: Call[] = []
  const launcher: Launcher = async (_exe, args, stdin) => {
    calls.push({ args, stdin })
    return missing ? null : { status: 0, stdout, stderr: '', timedOut: false, ...extra }
  }
  return { calls, launcher, last: () => calls[calls.length - 1] }
}

const make = (launcher: Launcher, enabled = true) => new EphyClient({ executable: 'C:\\e\\ephy.exe', launcher, isEnabled: () => enabled })

const fails = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return error instanceof EphyError ? error.code : 'other'
  }
  return 'none'
}

describe('client gates', () => {
  it('toggle off starts nothing', async () => {
    const f = fake(listJSON)
    const client = make(f.launcher, false)
    for (const run of [
      () => client.list(),
      () => client.get('aB3dK9xQ2mZp'),
      () => client.update('aB3dK9xQ2mZp', 'x', 1),
      () => client.create('t', 'x'),
      () => client.viewerUrl('aB3dK9xQ2mZp'),
      () => client.latest('aB3dK9xQ2mZp', 1)
    ]) expect(await fails(run)).toBe('disabled')
    expect(f.calls).toHaveLength(0)
  })

  it('a bad id starts nothing', async () => {
    const f = fake()
    const client = make(f.launcher)
    expect(await fails(() => client.get('--raw'))).toBe('invalidId')
    expect(await fails(() => client.update('../x', 'x'))).toBe('invalidId')
    expect(await fails(() => client.viewerUrl('a b c d e f'))).toBe('invalidId')
    expect(await fails(() => client.latest('-x', 1))).toBe('invalidId')
    expect(f.calls).toHaveLength(0)
  })
})

describe('arguments', () => {
  it('list clamps the limit', async () => {
    const f = fake(listJSON)
    const page = await make(f.launcher).list(5000)
    expect(f.last().args).toEqual(['post', 'list', '--limit', '1000', '--json'])
    expect(page.limit).toBe(1000)
    expect(page.artifacts).toHaveLength(2)
    await make(f.launcher).list(0)
    expect(f.last().args).toEqual(['post', 'list', '--limit', '1', '--json'])
    await make(f.launcher).list()
    expect(f.last().args).toEqual(['post', 'list', '--limit', '100', '--json'])
  })

  it('update sends the content on stdin with the base version', async () => {
    const f = fake('{"postId":"aB3dK9xQ2mZp","version":6}')
    expect(await make(f.launcher).update('aB3dK9xQ2mZp', '# New', 5)).toBe(6)
    expect(f.last().args).toEqual(['artifact', 'update', 'aB3dK9xQ2mZp', '-', '--json', '--base-version', '5'])
    expect(f.last().stdin).toBe('# New')
    // Content never appears in the arguments.
    expect(f.last().args.join(' ')).not.toContain('New')
  })

  it('update without a base version, and with a junk one', async () => {
    const f = fake('{"postId":"aB3dK9xQ2mZp","version":2}')
    await make(f.launcher).update('aB3dK9xQ2mZp', 'x')
    expect(f.last().args).toEqual(['artifact', 'update', 'aB3dK9xQ2mZp', '-', '--json'])
    expect(await fails(() => make(f.launcher).update('aB3dK9xQ2mZp', 'x', -1))).toBe('failed')
    expect(await fails(() => make(f.launcher).update('aB3dK9xQ2mZp', 'x', 1.5))).toBe('failed')
  })

  it('create cleans the title and keeps content on stdin', async () => {
    const f = fake('{"postId":"Nn1Nn2Nn3Nn4","version":1}')
    const made = await make(f.launcher).create('-x Plan', 'body')
    expect(made).toEqual({ id: 'Nn1Nn2Nn3Nn4', version: 1 })
    expect(f.last().args).toEqual(['artifact', 'new', '-', '--format', 'MARKDOWN', '--title', 'x Plan', '--no-project', '--json'])
    expect(f.last().stdin).toBe('body')
    expect(await fails(() => make(fake('No change').launcher).create('t', 'x'))).toBe('badOutput')
  })

  it('viewer url asks the CLI and only passes https', async () => {
    const f = fake('{"viewerUrl":"https://ephy.example.com/aB3dK9xQ2mZp"}')
    expect(await make(f.launcher).viewerUrl('aB3dK9xQ2mZp')).toBe('https://ephy.example.com/aB3dK9xQ2mZp')
    expect(f.last().args).toEqual(['post', 'open', 'aB3dK9xQ2mZp', '--json'])
    expect(await fails(() => make(fake('{"viewerUrl":"file:///c:/x"}').launcher).viewerUrl('aB3dK9xQ2mZp'))).toBe('badOutput')
  })
})

describe('failures', () => {
  it('signed out, timed out, missing', async () => {
    expect(await fails(() => make(fake('', { status: 1, stderr: 'Midway cookie expired. Run mwinit.' }).launcher).list())).toBe('signedOut')
    expect(await fails(() => make(fake('', { status: 15, timedOut: true }).launcher).list())).toBe('timedOut')
    expect(await fails(() => make(fake('', {}, true).launcher).list())).toBe('notFound')
  })
})

describe('saving and conflicts', () => {
  const link = { id: 'Nn1Nn2Nn3Nn4', version: 1 }

  it('a stale base version is a conflict and nothing is overwritten', async () => {
    const stale = fake('', { status: 1, stderr: 'base-version 1 is not the head (v3)' })
    expect(await fails(() => make(stale.launcher).update(link.id, 'x', link.version))).toBe('conflict')
    expect(stale.calls).toHaveLength(1)
  })

  it('a deleted or read-only artifact is unavailable', async () => {
    const gone = fake('', { status: 1, stderr: 'error: not found (404): Artifact or site not found: Nn1Nn2Nn3Nn4' })
    expect(await fails(() => make(gone.launcher).update(link.id, 'x', 1))).toBe('unavailable')
  })
})

describe('get latest', () => {
  const artifact = (version: number) =>
    JSON.stringify({ postId: 'Nn1Nn2Nn3Nn4', kind: 'artifact', format: 'MARKDOWN', title: 'Plan', version, content: `# Plan v${version}` })

  it('the same version is up to date', async () => {
    const f = fake(artifact(3))
    expect(await make(f.launcher).latest('Nn1Nn2Nn3Nn4', 3)).toEqual({ upToDate: true, version: 3 })
    expect(f.calls).toHaveLength(1)
    expect(f.last().args).toEqual(['post', 'get', 'Nn1Nn2Nn3Nn4', '--json'])
    expect(f.last().stdin).toBeUndefined()
  })

  it('a newer version carries the text, and only reads', async () => {
    const f = fake(artifact(5))
    const result = await make(f.launcher).latest('Nn1Nn2Nn3Nn4', 3)
    expect(result.upToDate).toBe(false)
    if (!result.upToDate) {
      expect(result.document.version).toBe(5)
      expect(result.document.content).toBe('# Plan v5')
    }
    expect(f.calls).toHaveLength(1)
    expect(f.last().args[0]).toBe('post')
  })

  it('an unknown stored version always asks', async () => {
    expect((await make(fake(artifact(3)).launcher).latest('Nn1Nn2Nn3Nn4', undefined)).upToDate).toBe(false)
    const noVersion = JSON.stringify({ postId: 'Nn1Nn2Nn3Nn4', format: 'TEXT', content: 'x' })
    expect((await make(fake(noVersion).launcher).latest('Nn1Nn2Nn3Nn4', 3)).upToDate).toBe(false)
  })

  it('errors keep their plain codes', async () => {
    expect(await fails(() => make(fake('', { status: 1, stderr: 'Run mwinit to sign in' }).launcher).latest('Nn1Nn2Nn3Nn4', 3))).toBe('signedOut')
    expect(await fails(() => make(fake('', { status: 1, stderr: 'error: forbidden (403)' }).launcher).latest('Nn1Nn2Nn3Nn4', 3))).toBe('unavailable')
    const off = fake(artifact(5))
    expect(await fails(() => make(off.launcher, false).latest('Nn1Nn2Nn3Nn4', 3))).toBe('disabled')
    expect(off.calls).toHaveLength(0)
  })
})
