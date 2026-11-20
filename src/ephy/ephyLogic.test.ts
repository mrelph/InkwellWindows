import { describe, expect, it } from 'vitest'
import { cleanTitle, dirtyAfterGetLatest, dirtyAfterPublish, filterArtifacts, getLatestPrompt, isUpToDate, noteId, noteName, relativeTime, versionLabel } from './ephyLogic'

/* Port of the pure parts of EphyTests.swift (links, Get Latest). */

describe('save to Ephy dirty flag', () => {
  it('a local file stays as it was; an Ephy note is clean unless typed during upload', () => {
    expect(dirtyAfterPublish({ ephyOnly: false, isDirty: true, sentRevision: 4, currentRevision: 4 })).toBe(true)
    expect(dirtyAfterPublish({ ephyOnly: false, isDirty: false, sentRevision: 4, currentRevision: 4 })).toBe(false)
    expect(dirtyAfterPublish({ ephyOnly: true, isDirty: true, sentRevision: 4, currentRevision: 4 })).toBe(false)
    expect(dirtyAfterPublish({ ephyOnly: true, isDirty: true, sentRevision: 4, currentRevision: 5 })).toBe(true)
  })
})

describe('get latest', () => {
  it('an unknown version always asks', () => {
    expect(isUpToDate(undefined, 3)).toBe(false)
    expect(isUpToDate(undefined, undefined)).toBe(false)
    expect(isUpToDate(3, undefined)).toBe(false)
    expect(isUpToDate(3, 3)).toBe(true)
  })

  it('the prompt shows both versions and warns about edits', () => {
    const clean = getLatestPrompt({ have: 3, next: 5, unsavedEdits: false, localFile: false })
    expect(clean.message).toBe('Replace this note with Ephy v5? (You have v3.)')
    expect(clean.detail).not.toContain('unsaved')
    const dirty = getLatestPrompt({ have: 3, next: 5, unsavedEdits: true, localFile: true })
    expect(dirty.detail).toContain('Your unsaved edits will be replaced')
    expect(dirty.detail).toContain('file on disk does not change')
    expect(getLatestPrompt({ have: undefined, next: undefined, unsavedEdits: false, localFile: false }).message)
      .toBe('Replace this note with the latest on Ephy? (You have an unknown version.)')
  })

  it('dirty after the replace', () => {
    expect(dirtyAfterGetLatest({ ephyOnly: true, wasDirty: true, textChanged: true })).toBe(false)
    expect(dirtyAfterGetLatest({ ephyOnly: false, wasDirty: false, textChanged: true })).toBe(true)
    expect(dirtyAfterGetLatest({ ephyOnly: false, wasDirty: true, textChanged: false })).toBe(true)
    expect(dirtyAfterGetLatest({ ephyOnly: false, wasDirty: false, textChanged: false })).toBe(false)
  })

  it('labels', () => {
    expect(versionLabel(7)).toBe('v7')
    expect(versionLabel(undefined)).toBe('an unknown version')
  })
})

describe('names and the picker filter', () => {
  it('note names and ids', () => {
    expect(noteName('  --Sprint\nnotes ')).toBe('Sprint notes.md')
    expect(noteName('')).toBe('Untitled note.md')
    expect(cleanTitle('x'.repeat(300))).toHaveLength(200)
    expect(noteId('aB3dK9xQ2mZp')).toBe('ephy:aB3dK9xQ2mZp')
  })

  it('filters by title or id, case-insensitively', () => {
    const rows = [{ id: 'aB3dK9xQ2mZp', title: 'Sprint notes' }, { id: 'Zz9Yy8Xx7Ww6', title: 'Plan' }]
    expect(filterArtifacts(rows, '  ')).toHaveLength(2)
    expect(filterArtifacts(rows, 'SPRINT').map((r) => r.id)).toEqual(['aB3dK9xQ2mZp'])
    expect(filterArtifacts(rows, 'zz9y').map((r) => r.title)).toEqual(['Plan'])
    expect(filterArtifacts(rows, 'nothing')).toEqual([])
  })

  it('relative times', () => {
    const now = 1_800_000_000_000
    expect(relativeTime(undefined, now)).toBe('')
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 hours ago')
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday')
  })
})
