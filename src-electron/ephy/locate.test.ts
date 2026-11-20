import { describe, expect, it } from 'vitest'
import { candidates, findEphy, runnableExtensions } from './locate'

/* Port of EphyLocatorTests, translated: ~/.toolbox/bin first, then PATH with
   PATHEXT instead of Homebrew and a login shell. */

const win = { platform: 'win32' as const, home: 'C:\\Users\\me', env: { Path: 'C:\\Tools;C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' } }

describe('PATHEXT', () => {
  it('keeps only runnable extensions, lowercased, in order', () => {
    expect(runnableExtensions('.COM;.EXE;.BAT;.CMD;.VBS;.JS;.MSC')).toEqual(['.com', '.exe', '.bat', '.cmd'])
    expect(runnableExtensions('.PS1;.VBS')).toEqual(['.exe', '.cmd'])
    expect(runnableExtensions(undefined)).toEqual(['.com', '.exe', '.bat', '.cmd'])
    expect(runnableExtensions('.exe;.EXE')).toEqual(['.exe'])
  })
})

describe('finding the CLI', () => {
  it('prefers the toolbox folder, then PATH in order', () => {
    const all = new Set([
      'C:\\Users\\me\\.toolbox\\bin\\ephy.exe',
      'C:\\Tools\\ephy.cmd',
      'C:\\Windows\\System32\\ephy.exe'
    ])
    expect(findEphy({ ...win, isFile: (p) => all.has(p) })).toBe('C:\\Users\\me\\.toolbox\\bin\\ephy.exe')
    expect(findEphy({ ...win, isFile: (p) => all.has(p) && !p.includes('.toolbox') })).toBe('C:\\Tools\\ephy.cmd')
    expect(findEphy({ ...win, isFile: (p) => p === 'C:\\Windows\\System32\\ephy.exe' })).toBe('C:\\Windows\\System32\\ephy.exe')
  })

  it('tries each extension in PATHEXT order inside one folder', () => {
    expect(findEphy({ ...win, isFile: (p) => p === 'C:\\Tools\\ephy.exe' || p === 'C:\\Tools\\ephy.cmd' })).toBe('C:\\Tools\\ephy.exe')
    expect(findEphy({ ...win, env: { ...win.env, PATHEXT: '.CMD;.EXE' }, isFile: (p) => p === 'C:\\Tools\\ephy.exe' || p === 'C:\\Tools\\ephy.cmd' })).toBe('C:\\Tools\\ephy.cmd')
  })

  it('is case-insensitive about PATH, ignores relative and quoted-empty entries, never picks .vbs or .js', () => {
    const list = candidates({ ...win, env: { PATH: '"C:\\Quoted Dir";.;relative;;C:\\Tools', pathext: '.VBS;.EXE' } })
    expect(list).toContain('C:\\Quoted Dir\\ephy.exe')
    expect(list.some((p) => p.startsWith('relative') || p.startsWith('.\\'))).toBe(false)
    expect(list.some((p) => /\.(vbs|js)$/.test(p))).toBe(false)
  })

  it('returns null when nothing exists', () => {
    expect(findEphy({ ...win, isFile: () => false })).toBeNull()
  })

  it('works on POSIX paths too (no extensions)', () => {
    expect(candidates({ platform: 'linux', home: '/h', env: { PATH: '/usr/bin:/opt/x' } })).toEqual([
      '/h/.toolbox/bin/ephy', '/usr/bin/ephy', '/opt/x/ephy'
    ])
  })
})
