import { inlineToText, slugify } from '../lib/headings'
import { isMarkdown } from '../lib/paths'

/* What a click on a link in the reader does — Mac AppModel.openLink:
   - `#slug` scrolls to that heading in the reader (ids come from the shared
     slugify + inlineToText, src/lib/headings.ts; a fragment written as heading
     text, `#My Heading`, is slugged the same way);
   - a relative link or a `file:` URL to a Markdown file opens that note in
     Inkwell. The renderer passes the raw href to main, which resolves it
     against the note's folder and validates it (src-electron/readerLinks.ts);
   - http, https and mailto go to the desktop's browser / mail app;
   - anything else (another scheme, a non-Markdown file) does nothing.
   DOM-free; unit tested. */

export type LinkAction =
  | { kind: 'anchor'; ids: string[] }
  | { kind: 'external'; url: string }
  | { kind: 'note'; href: string }
  | { kind: 'none' }

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const pathPartOf = (value: string) => value.split('#')[0].split('?')[0]

export function classifyLink(href: string | undefined): LinkAction {
  const raw = (href ?? '').trim()
  if (!raw || raw.includes('\0')) return { kind: 'none' }

  if (raw.startsWith('#')) {
    const fragment = decode(raw.slice(1))
    if (!fragment) return { kind: 'none' }
    const slug = slugify(inlineToText(fragment))
    return { kind: 'anchor', ids: slug === fragment ? [fragment] : [fragment, slug] }
  }

  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return { kind: 'external', url: raw }
    if (scheme === 'file') {
      let pathname: string
      try {
        pathname = decode(new URL(raw).pathname)
      } catch {
        return { kind: 'none' }
      }
      return isMarkdown(pathname) ? { kind: 'note', href: raw } : { kind: 'none' }
    }
    return { kind: 'none' }
  }

  /* `//host/x` is a protocol-relative web address, not a note. */
  if (raw.startsWith('//') || raw.startsWith('\\\\')) return { kind: 'none' }
  return isMarkdown(decode(pathPartOf(raw))) ? { kind: 'note', href: raw } : { kind: 'none' }
}
