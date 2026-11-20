import { describe, expect, it } from 'vitest'
import { getHeadings } from '../lib/headings'
import { classifyLink } from './links'

describe('classifyLink (Mac AppModel.openLink)', () => {
  it('#anchors scroll to a heading, by id or by heading text through the shared slug', () => {
    expect(classifyLink('#getting-started')).toEqual({ kind: 'anchor', ids: ['getting-started'] })
    expect(classifyLink('#Getting%20Started')).toEqual({ kind: 'anchor', ids: ['Getting Started', 'getting-started'] })
    expect(classifyLink('#')).toEqual({ kind: 'none' })
    // The slug the link produces is the id the reader and outline give the heading.
    const [heading] = getHeadings('# Getting *Started*\n')
    const action = classifyLink('#Getting Started')
    expect(action.kind === 'anchor' && action.ids).toContain(heading.id)
  })
  it('web and mail links go to the desktop', () => {
    for (const href of ['https://example.com', 'http://a.b/c', 'mailto:a@b.c', 'HTTPS://X.Y']) {
      expect(classifyLink(href)).toEqual({ kind: 'external', url: href })
    }
  })
  it('relative and file: links to Markdown open the note (main resolves them)', () => {
    for (const href of ['other.md', './sub/a.mdx', '../b.markdown#part', 'with%20space.md', 'file:///C:/notes/a.md']) {
      expect(classifyLink(href)).toEqual({ kind: 'note', href })
    }
  })
  it('everything else does nothing', () => {
    for (const href of [undefined, '', 'picture.png', 'file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x/a.md', '//host/a.md', '\\\\host\\share\\a.md', 'C:\\a.md', 'a\0.md']) {
      expect(classifyLink(href), String(href)).toEqual({ kind: 'none' })
    }
  })
})
