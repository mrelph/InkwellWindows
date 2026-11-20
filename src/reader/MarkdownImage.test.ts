import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownImage, attemptKey } from './MarkdownImage'

const note = 'C:\\Users\\me\\Notes\\a.md'
const html = (props: Parameters<typeof MarkdownImage>[0]) => renderToStaticMarkup(createElement(MarkdownImage, props))

describe('MarkdownImage (finding 11: a failed image never sticks)', () => {
  it('a failure is tied to one url and one retry key', () => {
    expect(attemptKey('inkwell-asset://local/?f=a', '')).not.toBe(attemptKey('inkwell-asset://local/?f=b', ''))
    expect(attemptKey('inkwell-asset://local/?f=a', 'C:\\Lib')).not.toBe(attemptKey('inkwell-asset://local/?f=a', 'C:\\Lib\nD:\\More'))
    expect(attemptKey('a\nb', '')).not.toBe(attemptKey('a', 'b'))
  })
  it('renders local images through the asset scheme and never requests a UNC one', () => {
    expect(html({ src: '../assets/x.png', alt: 'x', notePath: note })).toMatch(/<img[^>]+src="inkwell-asset:\/\/local\/\?f=/)
    const unc = html({ src: '\\\\attacker\\share\\x.png', alt: 'leak', notePath: note })
    expect(unc).not.toMatch(/<img/)
    expect(unc).toContain('image-placeholder')
    expect(unc).toContain('network shares')
  })
})
