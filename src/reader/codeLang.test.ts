import { describe, expect, it } from 'vitest'
import { codeLanguageLabel } from './codeLang'

describe('codeLanguageLabel', () => {
  it('uppercases the fence language', () => {
    expect(codeLanguageLabel('language-ts')).toBe('TS')
    expect(codeLanguageLabel('foo language-c++ bar')).toBe('C++')
  })
  it('is empty without a language', () => {
    expect(codeLanguageLabel(undefined)).toBe('')
    expect(codeLanguageLabel('hljs')).toBe('')
  })
})
