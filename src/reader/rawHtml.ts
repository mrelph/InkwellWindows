/* Raw HTML is shown as muted monospace text, never rendered (Mac parity). A
   remark plugin rewrites mdast `html` nodes into ordinary nodes that carry
   `data.hName`, so react-markdown renders `<div class="raw-html">` (block) or
   `<span class="raw-html">` (inline) holding the source text. No rehype-raw,
   so nothing can become live markup. */

type MdNode = {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

function rewrite(parent: MdNode): void {
  if (!parent.children) return
  parent.children = parent.children.map((child) => {
    if (child.type === 'html') {
      const text: MdNode = { type: 'text', value: (child.value ?? '').replace(/\n+$/, '') }
      if (BLOCK_PARENTS.has(parent.type)) {
        return { type: 'paragraph', children: [text], data: { hName: 'div', hProperties: { className: ['raw-html'] } } }
      }
      return { type: 'strong', children: [text], data: { hName: 'span', hProperties: { className: ['raw-html'] } } }
    }
    rewrite(child)
    return child
  })
}

export function remarkRawHtmlAsText() {
  return (tree: MdNode) => rewrite(tree)
}
