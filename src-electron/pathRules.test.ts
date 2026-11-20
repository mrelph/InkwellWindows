import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseNetUse } from './networkDrives'
import {
  broadFolderReason,
  isDevicePath,
  isLexicallyInside,
  isNetworkPath,
  isPlainAbsolute,
  networkAllowed,
  setNetworkDrives,
  stripExtendedPrefix,
  uncShareRoot
} from './pathRules'

const win = path.win32
const posix = path.posix
afterEach(() => setNetworkDrives([]))

describe('lexical path rules', () => {
  it('recognises network and device paths on Windows only', () => {
    for (const value of ['\\\\srv\\share\\a.png', '//srv/share/a.png', '\\/srv/share', '\\\\?\\C:\\a', '\\\\.\\pipe\\x', '\\\\srv@SSL\\DavWWWRoot\\x']) {
      expect(isNetworkPath(value, win), value).toBe(true)
    }
    for (const value of ['C:\\a.png', 'c:/a.png', '\\a.png']) expect(isNetworkPath(value, win), value).toBe(false)
    expect(isNetworkPath('//srv/share', posix)).toBe(false)
    expect(isDevicePath('\\\\?\\UNC\\srv\\share')).toBe(true)
    expect(isDevicePath('\\\\srv\\share')).toBe(false)
  })
  it('treats mapped network drive letters as network paths', () => {
    expect(isNetworkPath('X:\\pics\\a.png', win)).toBe(false)
    setNetworkDrives(['x'])
    expect(isNetworkPath('X:\\pics\\a.png', win)).toBe(true)
    expect(isNetworkPath('x:/pics', win)).toBe(true)
    expect(isNetworkPath('C:\\pics', win)).toBe(false)
  })
  it('isPlainAbsolute refuses relative, drive-relative, rooted, device and NUL paths', () => {
    expect(isPlainAbsolute('C:\\a.md', win)).toBe(true)
    expect(isPlainAbsolute('\\\\srv\\share\\a.md', win)).toBe(true)
    for (const value of ['a.md', 'C:a.md', '\\a.md', '/a.md', '\\\\?\\C:\\a.md', '\\\\.\\C:\\a.md', 'C:\\a\0.md', '', 42, null]) {
      expect(isPlainAbsolute(value, win), String(value)).toBe(false)
    }
    expect(isPlainAbsolute('/home/a.md', posix)).toBe(true)
    expect(isPlainAbsolute('home/a.md', posix)).toBe(false)
  })
  it('isLexicallyInside compares resolved and case-insensitively on Windows', () => {
    expect(isLexicallyInside('C:\\Notes\\a\\..\\b.md', 'c:\\notes', win)).toBe(true)
    expect(isLexicallyInside('C:\\Notes', 'C:\\Notes\\', win)).toBe(true)
    expect(isLexicallyInside('C:\\Notes2\\b.md', 'C:\\Notes', win)).toBe(false)
    expect(isLexicallyInside('C:\\Notes\\..\\b.md', 'C:\\Notes', win)).toBe(false)
    expect(isLexicallyInside('/n/A.md', '/N', posix)).toBe(false)
  })
  it('networkAllowed: only inside a root that is itself on the share', () => {
    expect(networkAllowed('C:\\a.png', [], win)).toBe(true)
    expect(networkAllowed('\\\\nas\\pics\\a.png', ['C:\\Notes'], win)).toBe(false)
    expect(networkAllowed('\\\\nas\\pics\\a.png', ['\\\\NAS\\Pics'], win)).toBe(true)
    expect(networkAllowed('\\\\nas\\other\\a.png', ['\\\\nas\\pics'], win)).toBe(false)
    expect(networkAllowed('\\\\nas\\pics\\a\\..\\..\\b.png', ['\\\\nas\\pics\\a'], win)).toBe(false)
    expect(networkAllowed('\\\\?\\UNC\\nas\\pics\\a.png', ['\\\\nas\\pics'], win)).toBe(false)
  })
  it('uncShareRoot and stripExtendedPrefix', () => {
    expect(uncShareRoot('\\\\Srv\\Share\\a\\b')).toBe('\\\\srv\\share')
    expect(uncShareRoot('\\\\?\\UNC\\srv\\share')).toBeNull()
    expect(stripExtendedPrefix('\\\\?\\C:\\a')).toBe('C:\\a')
    expect(stripExtendedPrefix('\\\\?\\UNC\\srv\\share\\a')).toBe('\\\\srv\\share\\a')
  })
})

describe('broad library folders (Mac refuses home and /)', () => {
  const home = 'C:\\Users\\me'
  it('refuses drive roots, the home folder and folders that hold it', () => {
    expect(broadFolderReason('C:\\', home, win)).toMatch(/whole drive/)
    expect(broadFolderReason('D:\\', home, win)).toMatch(/whole drive/)
    expect(broadFolderReason('c:\\users\\ME', home, win)).toMatch(/home folder/)
    expect(broadFolderReason('C:\\Users', home, win)).toMatch(/holds your home folder/)
    expect(broadFolderReason('/', '/home/me', posix)).toMatch(/whole drive/)
    expect(broadFolderReason('/home/me', '/home/me', posix)).toMatch(/home folder/)
  })
  it('accepts ordinary folders and network share roots', () => {
    expect(broadFolderReason('C:\\Users\\me\\Notes', home, win)).toBeNull()
    expect(broadFolderReason('D:\\Notes', home, win)).toBeNull()
    expect(broadFolderReason('\\\\nas\\notes', home, win)).toBeNull()
    setNetworkDrives(['X'])
    expect(broadFolderReason('X:\\', home, win)).toBeNull()
  })
})

describe('parseNetUse', () => {
  it('reads the mapped letters whatever the status column or locale says', () => {
    const output = [
      'New connections will be remembered.',
      '',
      'Status       Local     Remote                    Network',
      '-------------------------------------------------------------------------------',
      'Unavailable  X:        \\\\RELPHY-NAS\\Pictures     Microsoft Windows Network',
      'OK           Z:        \\\\server\\share            Microsoft Windows Network',
      'Getrennt     q:        \\\\host\\x                  Microsoft Windows Network',
      '             \\\\server\\ipc$                       Microsoft Windows Network',
      'The command completed successfully.'
    ].join('\r\n')
    expect(parseNetUse(output).sort()).toEqual(['Q', 'X', 'Z'])
    expect(parseNetUse('')).toEqual([])
  })
})
