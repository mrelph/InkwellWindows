import { describe, expect, it } from 'vitest'
import { reveal, webUrl, withMarkdownName } from './reveal'

describe('reveal', () => {
  it('shows invisible characters and drops control characters', () => {
    expect(reveal('a\u202Eb\u200Bc\u001B[31m\n\td')).toBe('a<U+202E>b<U+200B>c[31m\n\td')
    expect(reveal('\u{E0041}x\uFEFF')).toBe('<U+E0041>x<U+FEFF>')
  })
})

describe('webUrl', () => {
  it('accepts http and https only', () => {
    expect(webUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(webUrl('HTTP://example.com')).toBe('http://example.com/')
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'mailto:a@b.c', 'ftp://x', '//example.com', 'not a url', '', undefined]) {
      expect(webUrl(bad)).toBeNull()
    }
  })
})

describe('withMarkdownName', () => {
  it('adds .md only when missing', () => {
    expect(withMarkdownName('Untitled note')).toBe('Untitled note.md')
    expect(withMarkdownName('a.MD')).toBe('a.MD')
  })
})
