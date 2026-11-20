import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setNetworkDrives } from './pathRules'
import { resolveNoteLink } from './readerLinks'

const win = path.win32
const posix = path.posix
const note = 'C:\\Users\\me\\Notes\\today.md'
afterEach(() => setNetworkDrives([]))

describe('resolveNoteLink (Mac AppModel.openLink, resolved by main)', () => {
  it('resolves relative links against the note folder', () => {
    expect(resolveNoteLink(note, 'other.md', [], win)).toEqual({ ok: true, path: 'C:\\Users\\me\\Notes\\other.md' })
    expect(resolveNoteLink(note, 'sub/deep%20note.md#heading', [], win)).toEqual({ ok: true, path: 'C:\\Users\\me\\Notes\\sub\\deep note.md' })
    expect(resolveNoteLink(note, '../Archive/old.markdown?x=1', [], win)).toEqual({ ok: true, path: 'C:\\Users\\me\\Archive\\old.markdown' })
    expect(resolveNoteLink(note, '/root-relative.md', [], win)).toEqual({ ok: true, path: 'C:\\Users\\me\\Notes\\root-relative.md' })
  })
  it('accepts file: URLs to Markdown files', () => {
    expect(resolveNoteLink(note, 'file:///D:/Work/plan.md', [], win)).toEqual({ ok: true, path: 'D:\\Work\\plan.md' })
    expect(resolveNoteLink(note, 'file://localhost/D:/Work/plan.mdx', [], win)).toEqual({ ok: true, path: 'D:\\Work\\plan.mdx' })
    expect(resolveNoteLink('/home/me/n/a.md', 'file:///home/me/b.md', [], posix)).toEqual({ ok: true, path: '/home/me/b.md' })
  })
  it('does nothing for non-Markdown targets, anchors and other schemes', () => {
    expect(resolveNoteLink(note, 'picture.png', [], win)).toEqual({ ok: false, reason: 'notMarkdown' })
    expect(resolveNoteLink(note, 'file:///C:/Windows/System32/cmd.exe', [], win)).toEqual({ ok: false, reason: 'notMarkdown' })
    expect(resolveNoteLink(note, 'run.md.cmd', [], win)).toEqual({ ok: false, reason: 'notMarkdown' })
    for (const href of ['#section', '', 'https://example.com/a.md', 'javascript:alert(1)', 'C:x.md', 'a\0.md', 42]) {
      expect(resolveNoteLink(note, href, [], win).ok, String(href)).toBe(false)
    }
  })
  it('refuses links onto network shares outside the library (no NTLM leak)', () => {
    expect(resolveNoteLink(note, 'file://attacker/share/x.md', [], win)).toEqual({ ok: false, reason: 'network' })
    expect(resolveNoteLink(note, '//attacker/share/x.md', [], win)).toEqual({ ok: true, path: 'C:\\Users\\me\\Notes\\attacker\\share\\x.md' })
    expect(resolveNoteLink(note, 'file://nas/notes/x.md', ['\\\\nas\\notes'], win)).toEqual({ ok: true, path: '\\\\nas\\notes\\x.md' })
    setNetworkDrives(['X'])
    expect(resolveNoteLink(note, 'file:///X:/notes/a.md', [], win)).toEqual({ ok: false, reason: 'network' })
  })
  it('a note on a share may link within that share', () => {
    const nas = '\\\\nas\\notes\\work\\plan.md'
    expect(resolveNoteLink(nas, '../todo.md', [], win)).toEqual({ ok: true, path: '\\\\nas\\notes\\todo.md' })
    expect(resolveNoteLink(nas, 'file://evil/notes/x.md', [], win)).toEqual({ ok: false, reason: 'network' })
  })
  it('needs an absolute note to resolve against', () => {
    expect(resolveNoteLink('relative.md', 'other.md', [], win).ok).toBe(false)
  })
})
