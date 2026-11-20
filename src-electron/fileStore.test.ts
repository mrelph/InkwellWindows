import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeDocument, readMarkdownFile, writeAtomically } from './fileStore'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'inkwell-fs-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const errno = (code: string) => Object.assign(new Error(code), { code })

describe('writeAtomically', () => {
  it('creates and replaces files verbatim, returning the mtime and leaving no temp file', async () => {
    const target = path.join(dir, 'note.md')
    const first = await writeAtomically(target, 'a\r\nb\nc')
    expect(first).toBeGreaterThan(0)
    expect(await readFile(target, 'utf8')).toBe('a\r\nb\nc')
    await writeAtomically(target, 'é — ✓\n')
    expect(await readFile(target, 'utf8')).toBe('é — ✓\n')
    expect(await readdir(dir)).toEqual(['note.md'])
  })

  it('retries a transient EPERM and then succeeds', async () => {
    const target = path.join(dir, 'note.md')
    let calls = 0
    const { rename } = await import('node:fs/promises')
    await writeAtomically(target, 'x', {
      backoff: [1, 1, 1],
      rename: async (from, to) => { if (++calls < 3) throw errno('EPERM'); await rename(from, to) }
    })
    expect(calls).toBe(3)
    expect(await readFile(target, 'utf8')).toBe('x')
    expect(await readdir(dir)).toEqual(['note.md'])
  })

  it('falls back to a direct write when rename never succeeds, and cleans up', async () => {
    const target = path.join(dir, 'note.md')
    await writeFile(target, 'old')
    await writeAtomically(target, 'new', { backoff: [1, 1], rename: async () => { throw errno('EBUSY') } })
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['note.md'])
  })

  it('does not retry unrelated errors but still falls back and cleans up', async () => {
    const target = path.join(dir, 'note.md')
    let calls = 0
    await writeAtomically(target, 'v', { backoff: [1, 1], rename: async () => { calls++; throw errno('ENOSPC') } })
    expect(calls).toBe(1)
    expect(await readdir(dir)).toEqual(['note.md'])
  })
})

describe('decodeDocument', () => {
  it('reads plain UTF-8 and strips a UTF-8 BOM', () => {
    expect(decodeDocument(Buffer.from('héllo'))).toBe('héllo')
    expect(decodeDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Hi')]))).toBe('# Hi')
  })

  it('decodes UTF-16 LE and BE with a BOM', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Hé\r\n', 'utf16le')])
    expect(decodeDocument(le)).toBe('# Hé\r\n')
    const be = Buffer.from(le.subarray(2))
    be.swap16()
    expect(decodeDocument(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('# Hé\r\n')
  })

  it('falls back to lenient decoding for invalid UTF-8 instead of failing', () => {
    const text = decodeDocument(Buffer.from([0x61, 0xff, 0x62, 0xe9]))
    expect(text.startsWith('a')).toBe(true)
    expect(text).toContain('\uFFFD')
    expect(text).toContain('b')
  })

  it('reads a file from disk through the same path', async () => {
    const file = path.join(dir, 'bom.md')
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok')]))
    expect((await readMarkdownFile(file)).content).toBe('ok')
  })
})
