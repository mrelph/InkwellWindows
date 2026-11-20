import type { DiffLine } from '../ipc/contract'

/* A line diff for the write-permission sheet: remove / add / keep, with long
   unchanged runs folded to a few lines of context. Port of InkwellMac
   LineDiff.swift. */

/** shortcut: plain LCS, O(n*m). Above this many cells the whole old text is
    shown removed and the new one added. Upgrade to Myers if notes get huge. */
export const MAX_CELLS = 4_000_000

const split = (text: string): string[] => (text === '' ? [] : text.split('\n'))

export function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = split(oldText)
  const b = split(newText)
  let lines: DiffLine[] = []
  if (a.length * b.length > MAX_CELLS) {
    lines = [
      ...a.map((text): DiffLine => ({ op: 'remove', text })),
      ...b.map((text): DiffLine => ({ op: 'add', text }))
    ]
  } else {
    const width = b.length + 1
    // lengths[i * width + j] = LCS of a[i...] and b[j...]
    const lengths = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] = a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        lines.push({ op: 'keep', text: a[i] })
        i++
        j++
      } else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        lines.push({ op: 'remove', text: a[i] })
        i++
      } else {
        lines.push({ op: 'add', text: b[j] })
        j++
      }
    }
  }
  return fold(lines, context)
}

const unchanged = (count: number): DiffLine => ({ op: 'fold', text: `${count} unchanged line${count === 1 ? '' : 's'}` })

export function fold(lines: DiffLine[], context: number): DiffLine[] {
  const changed: number[] = []
  lines.forEach((line, index) => { if (line.op !== 'keep') changed.push(index) })
  if (changed.length === 0) return lines.length === 0 ? [] : [{ op: 'fold', text: 'No changes' }]
  const keep = new Set<number>()
  for (const index of changed) {
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) keep.add(near)
  }
  const result: DiffLine[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped > 0) {
        result.push(unchanged(skipped))
        skipped = 0
      }
      result.push(line)
    } else {
      skipped++
    }
  })
  if (skipped > 0) result.push(unchanged(skipped))
  return result
}
