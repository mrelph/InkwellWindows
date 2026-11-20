import { describe, expect, it } from 'vitest'
import { remarkRawHtmlAsText } from './rawHtml'

describe('remarkRawHtmlAsText', () => {
  it('turns block and inline html into text nodes with a raw-html class', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'html', value: '<div>x</div>\n' },
        { type: 'paragraph', children: [{ type: 'text', value: 'a ' }, { type: 'html', value: '<b>' }] }
      ]
    }
    remarkRawHtmlAsText()(tree)
    expect(tree.children[0].data.hName).toBe('div')
    expect(tree.children[0].children[0]).toEqual({ type: 'text', value: '<div>x</div>' })
    expect(tree.children[1].children[1].data.hName).toBe('span')
    expect(JSON.stringify(tree)).not.toContain('"type":"html"')
  })
})
