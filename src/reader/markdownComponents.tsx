import { isValidElement, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { inlineToText, slugify, uniqueId } from '../lib/headings'
import { codeLanguageLabel } from './codeLang'
import { MarkdownImage } from './MarkdownImage'
import './reader.css'

/* react-markdown element overrides. Owned by the reader workstream (C), which
   adds `img` (asset scheme + remote placeholder), the code-block language
   label and raw-HTML-as-text here. Heading ids MUST keep going through
   slugify + inlineToText — see src/lib/headings.ts. */

export const childrenToText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(childrenToText).join('')
  if (isValidElement(node)) return childrenToText((node.props as { children?: ReactNode }).children)
  return ''
}

export type MarkdownContext = {
  /** Absolute path of the note being rendered; undefined for drafts and Ephy notes. */
  notePath?: string
  /** A link was clicked (or activated from the keyboard): App decides what it
      does (src/reader/links.ts). Never a navigation of the app itself. */
  onLink?: (href: string) => void
  /** Changes when the library's folders do, so a failed image retries. */
  retryKey?: string
}

/** Builds the components for one render. `counts` must be fresh per render so
    ids stay stable and StrictMode's double invocation converges. */
export function markdownComponents(counts: Map<string, number>, context: MarkdownContext): Components {
  const anchor = (level: 1 | 2 | 3 | 4 | 5 | 6) => ({ children }: { children?: ReactNode }) => {
    const id = uniqueId(counts, slugify(inlineToText(childrenToText(children))))
    const Tag = `h${level}` as const
    return <Tag id={id}>{children}</Tag>
  }

  return {
    h1: anchor(1),
    h2: anchor(2),
    h3: anchor(3),
    h4: anchor(4),
    h5: anchor(5),
    h6: anchor(6),
    /* Wide tables scroll inside their own box instead of widening the page. */
    table: ({ node: _node, ...rest }) => (
      <div className="table-scroll">
        <table {...rest} />
      </div>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault()
          context.onLink?.(href ?? '')
        }}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, title }) => (
      <MarkdownImage
        src={typeof src === 'string' ? src : undefined}
        alt={alt}
        title={title}
        notePath={context.notePath}
        retryKey={context.retryKey}
      />
    ),
    pre: ({ children, node: _node, ...rest }) => {
      const code = Array.isArray(children) ? children[0] : children
      const className = isValidElement(code) ? (code.props as { className?: string }).className : undefined
      const label = codeLanguageLabel(className)
      return (
        <div className="code-block">
          {label ? <span className="code-lang">{label}</span> : null}
          <pre {...rest}>{children}</pre>
        </div>
      )
    }
  }
}
