import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from './markdownComponents'
import { remarkRawHtmlAsText } from './rawHtml'

/* The default transform strips file:, data: and relative image URLs before the
   `img` renderer sees them. Image sources are classified by resolveImageSource
   instead. Link hrefs keep the default scheme filter, except that `file:`
   survives so a `file:` link to a note can open it (classifyLink and main
   decide; the app never navigates to it). */
const urlTransform = (url: string, key: string) =>
  key === 'src' || (key === 'href' && /^file:/i.test(url.trim())) ? url : defaultUrlTransform(url)

/* The reading view. Owned by the reader workstream (C). */

export type ReaderProps = {
  content: string
  /** Absolute path of the note, for resolving note-relative images and links. */
  notePath?: string
  onLink?: (href: string) => void
  /** Changes when the library's folders do, so failed images retry once. */
  retryKey?: string
}

export function Reader({ content, notePath, onLink, retryKey }: ReaderProps) {
  /* Reset per render so ids stay stable and StrictMode's double invocation
     converges on the same result. */
  const counts = new Map<string, number>()

  return (
    <article className="markdown-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRawHtmlAsText]} urlTransform={urlTransform} components={markdownComponents(counts, { notePath, onLink, retryKey })}>
        {content}
      </ReactMarkdown>
    </article>
  )
}
