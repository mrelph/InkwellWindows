import { describe, expect, it } from 'vitest'
import { lineDiff } from './lineDiff'

const sign = { keep: ' ', remove: '-', add: '+', fold: '…' } as const
const show = (lines: ReturnType<typeof lineDiff>) => lines.map((line) => `${sign[line.op]}${line.text}`)

describe('lineDiff', () => {
  it('marks removed, added and kept lines', () => {
    expect(show(lineDiff('a\nb\nc', 'a\nB\nc\nd'))).toEqual([' a', '-b', '+B', ' c', '+d'])
  })

  it('folds long unchanged runs to a little context', () => {
    const old = Array.from({ length: 20 }, (_, i) => String(i + 1)).join('\n')
    const next = Array.from({ length: 20 }, (_, i) => (i === 9 ? 'ten' : String(i + 1))).join('\n')
    const folded = lineDiff(old, next, 1)
    expect(folded[0].op).toBe('fold')
    expect(folded.filter((line) => line.op !== 'fold').map((line) => line.text)).toEqual(['9', '10', 'ten', '11'])
    expect(folded[0].text).toBe('8 unchanged lines')
    expect(folded[folded.length - 1].text).toBe('9 unchanged lines')
  })

  it('previews a new file as all added', () => {
    expect(show(lineDiff('', 'x\ny'))).toEqual(['+x', '+y'])
  })

  it('says so when nothing changed', () => {
    expect(lineDiff('same\ntext', 'same\ntext')).toEqual([{ op: 'fold', text: 'No changes' }])
    expect(lineDiff('', '')).toEqual([])
  })

  it('falls back to remove-all add-all past the cell limit', () => {
    const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n')
    const other = Array.from({ length: 2100 }, (_, i) => `other ${i}`).join('\n')
    const lines = lineDiff(big, other, 0)
    expect(lines).toHaveLength(4200)
    expect(lines[0].op).toBe('remove')
    expect(lines[4199].op).toBe('add')
  })
})
