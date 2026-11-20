import { describe, expect, it } from 'vitest'
import { findMatches, indentEdit, matchIndexAt, matchIndexFrom, outdentEdit, replaceAllEdit, type TextEdit } from './findLogic'

const apply = (value: string, edit: TextEdit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end)

describe('findMatches', () => {
  it('is literal and case-insensitive by default', () => {
    expect(findMatches('a.b A.B axb', 'a.b', false)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
  })
  it('honours case sensitivity', () => {
    expect(findMatches('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }])
  })
  it('returns nothing for an empty query', () => {
    expect(findMatches('abc', '', false)).toEqual([])
  })
  it('does not overlap matches', () => {
    expect(findMatches('aaaa', 'aa', false)).toHaveLength(2)
  })
})

describe('matchIndexFrom', () => {
  const matches = findMatches('x a x a x', 'x', false) // 0, 4, 8
  it('goes forward and wraps', () => {
    expect(matchIndexFrom(matches, 1, 'forward')).toBe(1)
    expect(matchIndexFrom(matches, 9, 'forward')).toBe(0)
  })
  it('goes backward and wraps', () => {
    expect(matchIndexFrom(matches, 4, 'backward')).toBe(0)
    expect(matchIndexFrom(matches, 0, 'backward')).toBe(2)
  })
  it('is -1 with no matches', () => {
    expect(matchIndexFrom([], 0, 'forward')).toBe(-1)
  })
  it('finds the match under a selection', () => {
    expect(matchIndexAt(matches, 4, 5)).toBe(1)
    expect(matchIndexAt(matches, 4, 6)).toBe(-1)
  })
})

describe('replaceAllEdit', () => {
  it('rewrites the covering span as one edit', () => {
    const text = 'one cat, two Cats, three'
    const edit = replaceAllEdit(text, findMatches(text, 'cat', false), 'dog')!
    expect(apply(text, edit)).toBe('one dog, two dogs, three')
  })
  it('treats the replacement literally', () => {
    const text = 'a b'
    expect(apply(text, replaceAllEdit(text, findMatches(text, 'a', false), '$&$1')!)).toBe('$&$1 b')
  })
  it('is null with nothing to replace', () => {
    expect(replaceAllEdit('abc', [], 'x')).toBeNull()
  })
})

describe('indentEdit', () => {
  it('inserts two spaces at a caret', () => {
    const edit = indentEdit('ab', 1, 1)
    expect(apply('ab', edit)).toBe('a  b')
    expect(edit.selStart).toBe(3)
  })
  it('indents every selected line, skipping blanks', () => {
    const value = 'a\n\nb\nc'
    const edit = indentEdit(value, 0, 4)
    expect(apply(value, edit)).toBe('  a\n\n  b\nc')
    expect(edit.selStart).toBe(0)
    expect(edit.selEnd).toBe(8)
  })
  it('excludes a last line the selection only touches at column 0', () => {
    const value = 'a\nb\nc'
    expect(apply(value, indentEdit(value, 0, 4))).toBe('  a\n  b\nc')
  })
})

describe('outdentEdit', () => {
  it('removes up to two spaces or a tab per line', () => {
    const value = '    a\n\tb\n c\nd'
    const edit = outdentEdit(value, 0, value.length)!
    expect(apply(value, edit)).toBe('  a\nb\nc\nd')
  })
  it('works on a caret line and keeps the caret in place', () => {
    const edit = outdentEdit('  ab', 3, 3)!
    expect(apply('  ab', edit)).toBe('ab')
    expect(edit.selStart).toBe(1)
  })
  it('is null when there is no indent', () => {
    expect(outdentEdit('ab', 1, 1)).toBeNull()
  })
})
