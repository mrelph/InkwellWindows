/* Pure find/replace and indent logic for the Markdown editor. No DOM, so it is
   unit-tested directly (findLogic.test.ts). */

export type FindMatch = { start: number; end: number }

/** Upper bound so a one-letter query on a huge note cannot freeze the UI. */
export const MAX_MATCHES = 10_000

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** All non-overlapping matches of `query` in `text`, in order. A literal
    search: the query is never a pattern. */
export function findMatches(text: string, query: string, caseSensitive: boolean): FindMatch[] {
  if (!query) return []
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')
  const matches: FindMatch[] = []
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    matches.push({ start, end: start + match[0].length })
    if (matches.length >= MAX_MATCHES) break
  }
  return matches
}

/** The next match at or after `from` (forward) or the last one that starts
    before `from` (backward), wrapping at the ends. -1 when there are none. */
export function matchIndexFrom(matches: readonly FindMatch[], from: number, direction: 'forward' | 'backward'): number {
  if (!matches.length) return -1
  if (direction === 'forward') {
    const index = matches.findIndex((match) => match.start >= from)
    return index === -1 ? 0 : index
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index].start < from) return index
  }
  return matches.length - 1
}

/** Index of the match exactly covering [start, end), or -1. */
export function matchIndexAt(matches: readonly FindMatch[], start: number, end: number): number {
  return matches.findIndex((match) => match.start === start && match.end === end)
}

export type TextEdit = {
  /** The range of the old text to replace. */
  start: number
  end: number
  text: string
  /** Where the selection should land afterwards, in new-text coordinates. */
  selStart: number
  selEnd: number
}

/** Replacing every match is ONE edit: the smallest span covering all matches,
    rewritten. Null when there is nothing to replace. */
export function replaceAllEdit(text: string, matches: readonly FindMatch[], replacement: string): TextEdit | null {
  if (!matches.length) return null
  const start = matches[0].start
  const end = matches[matches.length - 1].end
  let out = ''
  let cursor = start
  for (const match of matches) {
    out += text.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  return { start, end, text: out, selStart: start, selEnd: start + out.length }
}

/* ---- Tab / Shift+Tab ---- */

export const INDENT = '  '

/** Whole lines touched by [start, end]. A selection ending exactly at the
    start of a line does not include that line. */
function lineSpan(value: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end
  const newline = value.indexOf('\n', effectiveEnd)
  return { lineStart, lineEnd: newline === -1 ? value.length : newline }
}

/** Tab: two spaces at the caret, or an indent of every line when the
    selection spans lines. */
export function indentEdit(value: string, start: number, end: number): TextEdit {
  if (!value.slice(start, end).includes('\n')) {
    const caret = start + INDENT.length
    return { start, end, text: INDENT, selStart: caret, selEnd: caret }
  }
  const { lineStart, lineEnd } = lineSpan(value, start, end)
  const lines = value.slice(lineStart, lineEnd).split('\n')
  let added = 0
  let firstAdded = 0
  const out = lines.map((line, index) => {
    if (!line) return line
    added += INDENT.length
    if (index === 0) firstAdded = INDENT.length
    return INDENT + line
  })
  return {
    start: lineStart,
    end: lineEnd,
    text: out.join('\n'),
    selStart: start === lineStart ? start : start + firstAdded,
    selEnd: end + added
  }
}

function leadingRemoval(line: string): number {
  if (line.startsWith('\t')) return 1
  if (line.startsWith(INDENT)) return INDENT.length
  if (line.startsWith(' ')) return 1
  return 0
}

/** Shift+Tab: removes one level of indent from every touched line. Null when
    nothing could be removed. */
export function outdentEdit(value: string, start: number, end: number): TextEdit | null {
  const { lineStart, lineEnd } = lineSpan(value, start, end)
  const lines = value.slice(lineStart, lineEnd).split('\n')
  let removed = 0
  let firstRemoved = 0
  const out = lines.map((line, index) => {
    const count = leadingRemoval(line)
    removed += count
    if (index === 0) firstRemoved = count
    return line.slice(count)
  })
  if (!removed) return null
  const selStart = Math.max(lineStart, start - firstRemoved)
  return {
    start: lineStart,
    end: lineEnd,
    text: out.join('\n'),
    selStart,
    selEnd: Math.max(selStart, end - removed)
  }
}
