import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getHeadings, inlineToText, slugify, uniqueId } from './headings'
import { plural, wordCount } from './text'

const ids = (markdown: string) => getHeadings(markdown).map((heading) => heading.id)
const outline = (markdown: string) => getHeadings(markdown).map((heading) => [heading.level, heading.text])

describe('getHeadings: ATX', () => {
  it('reads levels 1-3', () => {
    expect(outline('# One\n## Two\n### Three')).toEqual([[1, 'One'], [2, 'Two'], [3, 'Three']])
  })

  it('drops levels 4-6 from the outline', () => {
    expect(outline('#### Four\n##### Five\n###### Six\n# Kept')).toEqual([[1, 'Kept']])
  })

  it('strips trailing closing hashes', () => {
    expect(outline('## Closed ##')).toEqual([[2, 'Closed']])
    expect(outline('# Closed #####')).toEqual([[1, 'Closed']])
  })

  it('keeps a # that is part of the text', () => {
    expect(outline('# C# language')).toEqual([[1, 'C# language']])
  })

  it('requires a space after the hashes', () => {
    expect(outline('#nospace\n##alsono')).toEqual([])
  })

  it('allows up to three spaces of indent', () => {
    expect(outline('   # Indented')).toEqual([[1, 'Indented']])
  })

  it('skips empty headings', () => {
    expect(outline('# \n#\n# Real')).toEqual([[1, 'Real']])
  })

  it('handles CRLF-free content with no headings', () => {
    expect(getHeadings('')).toEqual([])
    expect(getHeadings('just a paragraph\n\nand another')).toEqual([])
  })

  it('strips inline markup from the heading text', () => {
    expect(outline('# A *very* `fancy` [link](http://x.y) heading')).toEqual([[1, 'A very fancy link heading']])
  })
})

describe('getHeadings: setext', () => {
  it('reads = as level 1 and - as level 2', () => {
    expect(outline('Title\n=====\n\nSub\n---')).toEqual([[1, 'Title'], [2, 'Sub']])
  })

  it('accepts a single-character underline', () => {
    expect(outline('Short\n=')).toEqual([[1, 'Short']])
  })

  it('does not treat a horizontal rule after a blank line as a heading', () => {
    expect(outline('Paragraph\n\n---\n\nMore')).toEqual([])
  })

  it('does not treat an ATX line followed by --- as setext', () => {
    expect(outline('# Atx\n---')).toEqual([[1, 'Atx']])
  })

  it('does not let a blank line become a setext heading', () => {
    expect(outline('\n===')).toEqual([])
  })
})

describe('getHeadings: fenced code', () => {
  it('ignores # inside backtick fences', () => {
    expect(outline('```\n# nope\n```\n# yes')).toEqual([[1, 'yes']])
  })

  it('ignores # inside tilde fences', () => {
    expect(outline('~~~\n# nope\n~~~\n# yes')).toEqual([[1, 'yes']])
  })

  it('handles an info string on the opening fence', () => {
    expect(outline('```bash\n# comment\n```\n## after')).toEqual([[2, 'after']])
  })

  it('handles longer fences', () => {
    expect(outline('````\n# nope\n````\n# yes')).toEqual([[1, 'yes']])
    expect(outline('~~~~~~\n# nope\n~~~~~~\n# yes')).toEqual([[1, 'yes']])
  })

  it('does not let a tilde line close a backtick fence', () => {
    expect(outline('```\n~~~\n# still code\n```\n# yes')).toEqual([[1, 'yes']])
  })

  it('does not let a backtick line close a tilde fence', () => {
    expect(outline('~~~\n```\n# still code\n~~~\n# yes')).toEqual([[1, 'yes']])
  })

  it('an unterminated fence swallows the rest of the document', () => {
    expect(outline('# before\n```\n# inside\n## inside')).toEqual([[1, 'before']])
  })

  it('does not treat setext underlines inside fences as headings', () => {
    expect(outline('```\nTitle\n=====\n```')).toEqual([])
  })

  // Fixed (CommonMark): a closing fence uses the opener's marker, is at least
  // as long, and carries no info string.
  it('a shorter fence inside a longer one does not close it', () => {
    expect(outline('````\n```\n# inside\n````\n# yes')).toEqual([[1, 'yes']])
  })

  it('a fence line with an info string does not close a block', () => {
    expect(outline('```\n```js\n# inside\n```\n# yes')).toEqual([[1, 'yes']])
  })

  it('a longer closing fence closes the block', () => {
    expect(outline('```\n# inside\n`````\n# yes')).toEqual([[1, 'yes']])
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('removes punctuation', () => {
    expect(slugify("What's new? (v2.0)!")).toBe('whats-new-v20')
  })

  it('collapses runs of whitespace and hyphens', () => {
    expect(slugify('a   b -- c')).toBe('a-b-c')
    expect(slugify('a - b')).toBe('a-b')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('-- hi --')).toBe('hi')
  })

  it('keeps digits', () => {
    expect(slugify('Step 1: Setup')).toBe('step-1-setup')
  })

  it('falls back to "section" when nothing survives', () => {
    expect(slugify('')).toBe('section')
    expect(slugify('***')).toBe('section')
    expect(slugify('   ')).toBe('section')
  })

  it('drops non-ASCII letters (current behaviour)', () => {
    expect(slugify('Café au lait')).toBe('caf-au-lait')
    expect(slugify('日本語')).toBe('section')
    expect(slugify('Ünïcode Straße')).toBe('ncode-strae')
  })

  it('drops emoji', () => {
    expect(slugify('Launch 🚀 day')).toBe('launch-day')
  })

  it('is idempotent on its own output', () => {
    const once = slugify('Some  Heading!! 2')
    expect(slugify(once)).toBe(once)
  })
})

describe('uniqueId and duplicate headings', () => {
  it('numbers repeats within a document', () => {
    const counts = new Map<string, number>()
    expect([uniqueId(counts, 'a'), uniqueId(counts, 'a'), uniqueId(counts, 'a'), uniqueId(counts, 'b')]).toEqual([
      'a', 'a-1', 'a-2', 'b'
    ])
  })

  it('numbers duplicate headings in order', () => {
    expect(ids('# Intro\n## Intro\n### Intro')).toEqual(['intro', 'intro-1', 'intro-2'])
  })

  it('numbers duplicates that slug identically across different text', () => {
    expect(ids('# Hello!\n# hello?\n# HELLO')).toEqual(['hello', 'hello-1', 'hello-2'])
  })

  it('headings with no sluggable text all get section ids', () => {
    expect(ids('# !!!\n# ???')).toEqual(['section', 'section-1'])
  })

  // Fixed: a literal heading "A 1" slugs to "a-1", the id the second "A" also
  // wanted; ids are now unique against suffixed slugs in either order.
  it('never produces two identical ids', () => {
    for (const text of ['# A\n# A\n# A 1', '# A 1\n# A\n# A', '# A\n# A-1\n# A\n# A']) {
      const list = ids(text)
      expect(new Set(list).size, text).toBe(list.length)
    }
    expect(ids('# A\n# A\n# A 1')).toEqual(['a', 'a-1', 'a-1-1'])
    expect(ids('# A 1\n# A\n# A')).toEqual(['a-1', 'a', 'a-2'])
  })
})

describe('inlineToText', () => {
  it('removes emphasis markers', () => {
    expect(inlineToText('**bold** and *italic* and _under_ and ~~gone~~')).toBe('bold and italic and under and gone')
  })

  it('removes code ticks', () => {
    expect(inlineToText('use `npm test` now')).toBe('use npm test now')
  })

  it('keeps link text, drops the url', () => {
    expect(inlineToText('[Docs](https://example.com/a_b)')).toBe('Docs')
  })

  it('keeps image alt text', () => {
    expect(inlineToText('![logo](a.png) Inkwell')).toBe('logo Inkwell')
  })

  it('trims', () => {
    expect(inlineToText('  hi  ')).toBe('hi')
  })

  it('leaves plain text alone', () => {
    expect(inlineToText('plain text')).toBe('plain text')
  })
})

describe('word count', () => {
  it('counts whitespace-separated words', () => {
    expect(wordCount('one two  three\nfour\tfive')).toBe(5)
  })

  it('is zero for empty or blank', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  \n\t ')).toBe(0)
  })

  it('counts markup tokens as words', () => {
    expect(wordCount('# Title\n\n- item')).toBe(4)
  })

  it('pluralizes', () => {
    expect(plural(1, 'word')).toBe('1 word')
    expect(plural(0, 'word')).toBe('0 words')
    expect(plural(2, 'word')).toBe('2 words')
  })
})

describe('outline/reader anchor invariant', () => {
  const root = path.resolve(__dirname, '..', '..')
  const read = (relative: string) => {
    try {
      return readFileSync(path.join(root, relative), 'utf8')
    } catch {
      return ''
    }
  }

  it('the outline derives anchors with slugify(inlineToText(...)) via getHeadings', () => {
    const [heading] = getHeadings('## A **bold** [link](http://x) idea')
    expect(heading.id).toBe(slugify(inlineToText('A **bold** [link](http://x) idea')))
    expect(heading.id).toBe('a-bold-link-idea')
  })

  it('the reader imports slugify/inlineToText/uniqueId from lib/headings instead of re-implementing', () => {
    const source = ['src/reader/markdownComponents.tsx', 'src/reader/Reader.tsx'].map(read).join('\n')
    expect(source.length).toBeGreaterThan(0)
    expect(source).toMatch(/from ['"][./]*(?:lib|\.\.\/lib)\/headings['"]/)
    expect(source).toMatch(/slugify/)
    expect(source).toMatch(/inlineToText|childrenToText|uniqueId/)
    // No second slug implementation in the reader.
    expect(source).not.toMatch(/\.replace\(\/\[\^a-z0-9/)
  })

  it('the outline component takes ids from getHeadings rather than slugging itself', () => {
    const outline = read('src/components/Outline.tsx')
    expect(outline).not.toMatch(/\.toLowerCase\(\)\s*\.replace/)
  })
})
