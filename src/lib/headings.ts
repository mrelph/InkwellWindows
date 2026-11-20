/* Heading anchors are derived from heading *text*, not from an ordinal. The
   outline scanner and the reader's heading renderers are two independent
   parsers, so an ordinal scheme silently shifts every later anchor whenever
   they disagree (a `#` inside a fenced block, a setext heading). A content slug
   keeps every other heading correct even when one entry is missed. Both sides
   go through slugify + inlineToText — change one, change the other. */

export type Heading = { level: number; text: string; id: string }

export const inlineToText = (value: string) =>
  value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()

export const slugify = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'section'
}

/** `base`, then `base-1`, `base-2`… for repeats within one document. Every id
    handed out is recorded in `counts` too, so a suffix never collides with a
    heading whose own text slugs to the same thing ("A", "A", "A 1" gives
    `a`, `a-1`, `a-1-1`; "A 1", "A", "A" gives `a-1`, `a`, `a-2`). The reader
    and the outline both call this, in document order, so both sides agree. */
export const uniqueId = (counts: Map<string, number>, base: string) => {
  let seen = counts.get(base) ?? 0
  let id = seen === 0 ? base : `${base}-${seen}`
  while (seen > 0 && counts.has(id)) {
    seen += 1
    id = `${base}-${seen}`
  }
  counts.set(base, seen + 1)
  if (id !== base) counts.set(id, 1)
  return id
}

/* Fence- and setext-aware so the outline matches what the reader actually
   renders. Levels 1-3 only, matching the outline's three indent levels. */
export const getHeadings = (markdown: string): Heading[] => {
  const headings: Heading[] = []
  const counts = new Map<string, number>()
  const lines = markdown.split('\n')
  /* The open fence's run (e.g. "````"). CommonMark: it closes only on a line
     of the same marker, at least as long, with nothing after it but spaces. */
  let fence: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceEdge = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''))
    if (fenceEdge) {
      const run = fenceEdge[1]
      if (!fence) {
        fence = run
        continue
      }
      if (run[0] === fence[0] && run.length >= fence.length && fenceEdge[2].trim() === '') {
        fence = null
        continue
      }
    }
    if (fence) continue

    let level = 0
    let raw = ''
    const atx = /^\s{0,3}(#{1,3})\s+(.*)$/.exec(line)
    if (atx) {
      level = atx[1].length
      raw = atx[2].replace(/\s+#+\s*$/, '')
    } else {
      const underline = lines[index + 1]
      const isSetext = underline !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(underline)
      if (isSetext && line.trim() && !/^\s{0,3}#/.test(line)) {
        level = underline.trim().startsWith('=') ? 1 : 2
        raw = line
      }
    }

    const text = inlineToText(raw)
    if (!level || !text) continue
    headings.push({ level, text, id: uniqueId(counts, slugify(text)) })
  }

  return headings
}
