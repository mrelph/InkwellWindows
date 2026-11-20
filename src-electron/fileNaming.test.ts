import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exists, isMarkdown, toFileName, uniqueCopyPath } from './fileStore'

const win = (name: string) => toFileName(name, 'win32')
const posix = (name: string) => toFileName(name, 'linux')

describe('toFileName (win32)', () => {
  it('adds .md when the extension is missing', () => {
    expect(win('notes')).toBe('notes.md')
    expect(win('notes.txt')).toBe('notes.txt.md')
  })

  it('keeps an existing Markdown extension in any case', () => {
    expect(win('notes.md')).toBe('notes.md')
    expect(win('Notes.MDX')).toBe('Notes.MDX')
    expect(win('a.Markdown')).toBe('a.Markdown')
  })

  it('trims surrounding whitespace', () => {
    expect(win('  notes  ')).toBe('notes.md')
  })

  it('rejects empty, dot and dotdot', () => {
    for (const name of ['', '   ', '.', '..']) expect(win(name)).toBeNull()
  })

  it('rejects separators and traversal', () => {
    for (const name of ['a/b', 'a\\b', '../x', '..\\x', 'C:\\x.md', '/etc/passwd']) expect(win(name)).toBeNull()
  })

  it('rejects each illegal character', () => {
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) expect(win(`a${ch}b`), ch).toBeNull()
  })

  it('rejects control characters and NUL', () => {
    expect(win('a\u0001b')).toBeNull()
    expect(win('a\u001fb')).toBeNull()
    expect(win('a\0b')).toBeNull()
  })

  it('rejects names starting with a dot', () => {
    expect(win('.hidden')).toBeNull()
    expect(win('.md')).toBeNull()
  })

  it('rejects a trailing dot', () => {
    expect(win('notes.')).toBeNull()
    expect(win('notes...')).toBeNull()
  })

  it('a trailing space is trimmed away, not preserved', () => {
    expect(win('notes ')).toBe('notes.md')
  })

  it('rejects reserved device names regardless of case or extension', () => {
    const reserved = ['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])]
    for (const name of reserved) {
      expect(win(name), name).toBeNull()
      expect(win(name.toLowerCase()), name).toBeNull()
      expect(win(`${name}.md`), name).toBeNull()
      expect(win(`${name}.txt`), name).toBeNull()
    }
  })

  it('allows names that merely contain or extend a reserved word', () => {
    for (const name of ['console', 'CON1', 'COM0', 'COM10', 'LPT0', 'auxiliary', 'nullable', 'my.con']) {
      expect(win(name), name).toBe(`${name}.md`)
    }
  })

  it('enforces the 255 character cap', () => {
    const ok = 'a'.repeat(252) + '.md'
    expect(ok).toHaveLength(255)
    expect(win(ok)).toBe(ok)
    expect(win('a'.repeat(256))).toBeNull()
  })

  it('allows spaces, unicode, dashes and parens', () => {
    expect(win('Meeting notes (v2) – café')).toBe('Meeting notes (v2) – café.md')
  })

  // Fixed: the limit applies after ".md" is appended (a 253-char name used to
  // pass and become 256 chars).
  it('the returned name never exceeds 255 chars', () => {
    const out = win('a'.repeat(253))
    expect(out === null || out.length <= 255).toBe(true)
  })
})

describe('toFileName (posix)', () => {
  it('does not apply Windows-only rules', () => {
    expect(posix('a:b')).toBe('a:b.md')
    expect(posix('CON')).toBe('CON.md')
    expect(posix('notes.')).toBe('notes..md')
  })

  it('still rejects separators, dot-leading and empties', () => {
    expect(posix('a/b')).toBeNull()
    expect(posix('.x')).toBeNull()
    expect(posix('..')).toBeNull()
    expect(posix('')).toBeNull()
  })

  it('caps at 255 bytes, not characters, extension included', () => {
    expect(posix('é'.repeat(126))).toBe(`${'é'.repeat(126)}.md`)
    expect(posix('é'.repeat(127))).toBeNull()
  })
})

describe('isMarkdown (main process copy)', () => {
  it('matches the renderer rules', () => {
    expect(isMarkdown('a.MD')).toBe(true)
    expect(isMarkdown('a.mdx')).toBe(true)
    expect(isMarkdown('a.markdown')).toBe(true)
    expect(isMarkdown('a.txt')).toBe(false)
  })
})

describe('uniqueCopyPath', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'inkwell-naming-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const touch = (name: string) => writeFile(path.join(dir, name), 'x')

  it('picks "notes copy.md" first', async () => {
    await touch('notes.md')
    expect(await uniqueCopyPath(path.join(dir, 'notes.md'))).toBe(path.join(dir, 'notes copy.md'))
  })

  it('then "notes copy 2.md", "notes copy 3.md"', async () => {
    await touch('notes.md')
    await touch('notes copy.md')
    expect(await uniqueCopyPath(path.join(dir, 'notes.md'))).toBe(path.join(dir, 'notes copy 2.md'))
    await touch('notes copy 2.md')
    expect(await uniqueCopyPath(path.join(dir, 'notes.md'))).toBe(path.join(dir, 'notes copy 3.md'))
  })

  it('fills a gap rather than skipping past it', async () => {
    await touch('notes.md')
    await touch('notes copy.md')
    await touch('notes copy 3.md')
    expect(await uniqueCopyPath(path.join(dir, 'notes.md'))).toBe(path.join(dir, 'notes copy 2.md'))
  })

  it('preserves the extension and stays in the same directory', async () => {
    const sub = path.join(dir, 'sub')
    await mkdir(sub)
    await writeFile(path.join(sub, 'a.mdx'), 'x')
    expect(await uniqueCopyPath(path.join(sub, 'a.mdx'))).toBe(path.join(sub, 'a copy.mdx'))
  })

  it('copying a copy appends to the copy name', async () => {
    await touch('notes copy.md')
    expect(await uniqueCopyPath(path.join(dir, 'notes copy.md'))).toBe(path.join(dir, 'notes copy copy.md'))
  })

  it('works when the source has no extension', async () => {
    await touch('README')
    expect(await uniqueCopyPath(path.join(dir, 'README'))).toBe(path.join(dir, 'README copy'))
  })

  it('does not require the source to exist', async () => {
    expect(await uniqueCopyPath(path.join(dir, 'ghost.md'))).toBe(path.join(dir, 'ghost copy.md'))
  })

  it('gives up (null) after 50 attempts', async () => {
    await touch('n.md')
    await touch('n copy.md')
    for (let i = 2; i <= 50; i += 1) await touch(`n copy ${i}.md`)
    expect(await uniqueCopyPath(path.join(dir, 'n.md'))).toBeNull()
  })

  it('exists() reflects the disk', async () => {
    await touch('here.md')
    expect(await exists(path.join(dir, 'here.md'))).toBe(true)
    expect(await exists(path.join(dir, 'gone.md'))).toBe(false)
  })
})
