import { MAX_MATCHES } from './findLogic'

/* Find inside the rendered Markdown (Read view). There is no webContents
   .findInPage channel in the IPC contract, so matches are found in the DOM
   text nodes and painted with the CSS Custom Highlight API, which marks text
   without touching the React-owned DOM. A match split across inline elements
   (e.g. half of it bold) is not found. */

const ALL = 'inkwell-find'
const CURRENT = 'inkwell-find-current'

export function collectReaderMatches(root: Element, query: string, caseSensitive: boolean): Range[] {
  if (!query) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    const haystack = caseSensitive ? text : text.toLowerCase()
    if (haystack.length !== text.length) continue // case folding changed offsets; skip rather than mis-highlight
    let from = 0
    for (let at = haystack.indexOf(needle, from); at !== -1; at = haystack.indexOf(needle, from)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
      from = at + needle.length
      if (ranges.length >= MAX_MATCHES) return ranges
    }
  }
  return ranges
}

export function paintReaderMatches(ranges: readonly Range[], current: number): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  CSS.highlights.set(ALL, new Highlight(...ranges))
  const active = ranges[current]
  if (active) CSS.highlights.set(CURRENT, new Highlight(active))
  else CSS.highlights.delete(CURRENT)
}

export function clearReaderMatches(): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

export function revealReaderMatch(range: Range): void {
  const element = range.startContainer.parentElement
  element?.scrollIntoView({ block: 'center', inline: 'nearest' })
}
