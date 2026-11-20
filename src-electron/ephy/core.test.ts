import { describe, expect, it } from 'vitest'
import { listJSON } from './test/fixtures'
import { EphyError, classify, cleanTitle, isValidId, parseDate, parseDocument, parseList, parsePublished, parseViewerUrl } from './core'

/* Port of InkwellMac Tests/InkwellCoreTests/EphyTests.swift, parsing suite. */

const code = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof EphyError ? error.code : 'other'
  }
  return undefined
}

describe('parsing', () => {
  it('list keeps only text artifacts with good ids', () => {
    const parsed = parseList(listJSON)
    expect(parsed.rawCount).toBe(6)
    expect(parsed.artifacts.map((a) => a.id)).toEqual(['aB3dK9xQ2mZp', 'Zz9Yy8Xx7Ww6'])
    expect(parsed.artifacts[0].title).toBe('Sprint notes')
    expect(parsed.artifacts[0].format).toBe('MARKDOWN')
    expect(parsed.artifacts[0].updatedAt).toBe(1794847781902)
    // A blank title falls back to the id; nine fractional digits parse.
    expect(parsed.artifacts[1].title).toBe('Zz9Yy8Xx7Ww6')
    expect(Math.abs((parsed.artifacts[1].updatedAt ?? 0) - 1793767037354)).toBeLessThan(10)
  })

  it('list accepts empty, bare arrays and alternate keys, and rejects junk', () => {
    expect(parseList('{"artifacts": []}').artifacts).toEqual([])
    expect(parseList('[{"id":"aB3dK9xQ2mZp","format":"text"}]').artifacts).toHaveLength(1)
    expect(parseList('{"items":[{"postId":"aB3dK9xQ2mZp","format":"MARKDOWN"}]}').artifacts).toHaveLength(1)
    expect(code(() => parseList('not json'))).toBe('badOutput')
    expect(code(() => parseList('{"other": 1}'))).toBe('badOutput')
  })

  it('reads millisecond and second timestamps and ISO strings', () => {
    expect(parseDate(1_794_847_781_902)).toBe(1_794_847_781_902)
    expect(parseDate(1_794_847_781.902)).toBe(1_794_847_781_902)
    expect(parseDate('2026-11-04T04:37:17Z')).not.toBeUndefined()
    expect(parseDate('yesterday')).toBeUndefined()
    expect(parseDate(undefined)).toBeUndefined()
  })

  it('document', () => {
    const json = '{"postId":"aB3dK9xQ2mZp","kind":"artifact","format":"MARKDOWN","title":"Notes","version":5,"content":"# Hi\\n"}'
    expect(parseDocument(json)).toEqual({ id: 'aB3dK9xQ2mZp', title: 'Notes', format: 'MARKDOWN', version: 5, content: '# Hi\n' })
    expect(code(() => parseDocument('{"postId":"aB3dK9xQ2mZp","kind":"artifact","format":"HTML","content":"<p>"}'))).toBe('unsupported')
    expect(code(() => parseDocument('{"postId":"aB3dK9xQ2mZp","kind":"site","format":"MARKDOWN","content":""}'))).toBe('unsupported')
    expect(code(() => parseDocument('{"postId":"aB3dK9xQ2mZp","kind":"artifact","format":"TEXT"}'))).toBe('badOutput')
    expect(code(() => parseDocument('{"postId":"-x","format":"TEXT","content":""}'))).toBe('badOutput')
    expect(parseDocument('{"postId":"aB3dK9xQ2mZp","format":"TEXT","content":"x","version":"7"}').version).toBe(7)
  })

  it('published and viewer', () => {
    expect(parsePublished('{"postId":"Nn1Nn2Nn3Nn4","url":"x","version":1,"status":"OK"}')).toEqual({ id: 'Nn1Nn2Nn3Nn4', version: 1 })
    expect(parsePublished('No change').version).toBeUndefined()
    expect(parseViewerUrl('{"viewerUrl":"https://ephy.amazon.dev/aB3dK9xQ2mZp/notes"}')).toBe('https://ephy.amazon.dev/aB3dK9xQ2mZp/notes')
    expect(parseViewerUrl('https://ephy.amazon.dev/x\n')).toBe('https://ephy.amazon.dev/x')
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://ephy.amazon.dev/x', 'ms-msdt:/id', '']) {
      expect(parseViewerUrl(JSON.stringify({ viewerUrl: bad }))).toBeNull()
    }
    expect(parseViewerUrl('{"viewerUrl":"file:///etc/passwd"}')).toBeNull()
  })
})

describe('ids and titles', () => {
  it('validates ids', () => {
    expect(isValidId('aB3dK9xQ2mZp')).toBe(true)
    expect(isValidId('abcdef')).toBe(true)
    expect(isValidId('a'.repeat(40))).toBe(true)
    for (const bad of ['', 'abc', '-rm-rf', '--raw', 'aB3d K9xQ', 'aB3dK9xQ2mZp/x', 'https://ephy.amazon.dev/aB3dK9xQ2mZp',
      'aB3dK9xQ2mZp;ls', 'ünïcödé123', 'a'.repeat(41), 'aB3dK9xQ2mZp\n', 'aB3dK9xQ2mZp&calc', 'abc%PATH%']) {
      expect(isValidId(bad), bad).toBe(false)
    }
    expect(isValidId(undefined)).toBe(false)
    expect(isValidId(12345678)).toBe(false)
  })

  it('cleans titles', () => {
    expect(cleanTitle('  --title\nnext  ')).toBe('title next')
    expect(cleanTitle('---')).toBe('Untitled note')
    expect(Array.from(cleanTitle('x'.repeat(300)))).toHaveLength(200)
    expect(cleanTitle('')).toBe('Untitled note')
  })
})

describe('error classification', () => {
  const run = (status: number, stderr: string) => {
    const error = classify(status, stderr)
    return { code: error.code, message: error.message }
  }

  it('signed out and expired Midway sessions', () => {
    expect(run(1, 'Error: run mwinit to refresh your Midway session').code).toBe('signedOut')
    expect(run(1, 'Your session expired').code).toBe('signedOut')
    expect(run(1, 'Midway cookie expired. Run mwinit.').code).toBe('signedOut')
    expect(run(1, 'status 401').code).toBe('signedOut')
    expect(run(1, 'x').message).not.toContain('mwinit')
    expect(classify(1, 'mwinit').message).toContain('mwinit')
  })

  it('conflict, gone, and the first real line', () => {
    expect(run(1, 'base-version 4 is not the head (v5)').code).toBe('conflict')
    expect(run(2, 'bad flag: --x\nmore')).toEqual({ code: 'failed', message: 'bad flag: --x' })
    expect(run(1, 'error: not found (404): Artifact or site not found: aB3dK9xQ2mZp').code).toBe('unavailable')
    expect(run(1, 'error: forbidden (403): not an editor').code).toBe('unavailable')
    expect(run(3, '')).toEqual({ code: 'failed', message: "Ephy couldn't do that (exit 3)." })
    // An info note before the real error must not hide it.
    expect(run(1, 'info: The content check is unavailable right now.\nerror: upload refused\n').message).toBe('error: upload refused')
    expect(run(1, 'warning: unknown project\n\nError: quota exceeded').message).toBe('Error: quota exceeded')
    // Only a note: show it, with the exit code so it reads as a failure.
    expect(run(4, 'info: The content check is unavailable right now.\n').message).toBe('info: The content check is unavailable right now. (exit 4)')
    expect(run(1, 'x'.repeat(500)).message).toHaveLength(200)
  })

  it('only the conflict error offers Get Latest', () => {
    expect(new EphyError('conflict').offersGetLatest).toBe(true)
    expect(new EphyError('unavailable').offersGetLatest).toBe(false)
    expect(new EphyError('signedOut').offersGetLatest).toBe(false)
  })
})
