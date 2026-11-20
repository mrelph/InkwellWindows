import { describe, expect, it } from 'vitest'
import { SHORTCUTS, matchShortcut, type KeyLike } from './shortcuts'

/* Finding 5: on Windows AltGr arrives as Ctrl+Alt (Chromium also sets the
   AltGraph modifier). German, French and Spanish layouts type `\` with AltGr,
   so a Ctrl shortcut that ignored Alt swallowed the character. */

const bs = String.fromCharCode(92)
const event = (key: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})
const altGr = (key: string) => event(key, { ctrlKey: true, altKey: true, altGraph: true })

describe('AltGr never triggers a Ctrl shortcut', () => {
  it('the reviewer scenario: AltGr+\\ in a textarea types a backslash, not Toggle Outline', () => {
    expect(matchShortcut(event(bs, { ctrlKey: true, altKey: true }), true)?.id).toBeUndefined()
    expect(matchShortcut(altGr(bs), true)?.id).toBeUndefined()
    expect(matchShortcut(altGr(bs), false)?.id).toBeUndefined()
    // Plain Ctrl+\ still toggles the outline.
    expect(matchShortcut(event(bs, { ctrlKey: true }), true)?.id).toBe('toggleOutline')
  })
  it('no Ctrl-only binding matches with Alt down (every AltGr character on every layout)', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.ctrl !== true || shortcut.alt === true) continue
      const shift = shortcut.shift === true
      expect(matchShortcut(event(shortcut.key, { ctrlKey: true, altKey: true, shiftKey: shift }), false), shortcut.id).toBeNull()
      expect(matchShortcut(event(shortcut.key, { ctrlKey: true, altKey: true, shiftKey: shift }), true), shortcut.id).toBeNull()
    }
  })
  it('Ctrl+Alt bindings fire for a real Ctrl+Alt but ignore an AltGr press', () => {
    expect(matchShortcut(event('a', { ctrlKey: true, altKey: true }), true)?.id).toBe('toggleAgentPanel')
    expect(matchShortcut(event('c', { ctrlKey: true, altKey: true }), false)?.id).toBe('copyPath')
    expect(matchShortcut(altGr('a'), true)).toBeNull()
    expect(matchShortcut(altGr('c'), false)).toBeNull()
  })
  it('keys without Ctrl are unaffected', () => {
    expect(matchShortcut(event('F3'), true)?.id).toBe('findNext')
    expect(matchShortcut(event('Escape', { altGraph: true }), true)?.id).toBe('escape')
  })
})
