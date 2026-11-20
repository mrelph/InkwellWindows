import { describe, expect, it } from 'vitest'
import { getHeadings, inlineToText, slugify } from './headings'

describe('headings', () => {
  it('slugs heading text and numbers repeats', () => {
    const headings = getHeadings('# Welcome to Inkwell\n\n## A **bold** idea\n\n## A bold idea\n')
    expect(headings).toEqual([
      { level: 1, text: 'Welcome to Inkwell', id: 'welcome-to-inkwell' },
      { level: 2, text: 'A bold idea', id: 'a-bold-idea' },
      { level: 2, text: 'A bold idea', id: 'a-bold-idea-1' }
    ])
  })

  it('ignores headings inside fenced code and reads setext headings', () => {
    const markdown = ['Title', '=====', '', '```md', '# not a heading', '```', '', 'Section', '-------', '#### too deep'].join('\n')
    expect(getHeadings(markdown).map((heading) => [heading.level, heading.id])).toEqual([
      [1, 'title'],
      [2, 'section']
    ])
  })

  it('strips inline markup before slugging, falling back to "section"', () => {
    expect(inlineToText('[Link](https://example.com) and `code`')).toBe('Link and code')
    expect(slugify('***')).toBe('section')
  })
})
