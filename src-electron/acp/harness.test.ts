import { describe, expect, it } from 'vitest'
import {
  buildSpawn,
  childEnvironment,
  executableExtensions,
  harnessDefinition,
  locateHarness,
  searchFolders
} from './harness'

const env = {
  Path: 'C:\\Windows;C:\\tools\\;"C:\\Program Files\\nodejs";relative\\bin;C:\\Windows',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me'
}

describe('finding a harness on Windows', () => {
  it('reads PATH whatever its case, drops duplicates and relative entries, adds npm\'s folder', () => {
    const folders = searchFolders(env, true)
    expect(folders.slice(0, 3)).toEqual(['C:\\Windows', 'C:\\tools\\', 'C:\\Program Files\\nodejs'])
    expect(folders).toContain('C:\\Users\\me\\AppData\\Roaming\\npm')
    expect(folders).not.toContain('relative\\bin')
    expect(folders.filter((folder) => folder === 'C:\\Windows')).toHaveLength(1)
  })

  it('tries .exe, .cmd, .bat in that order, limited to PATHEXT', () => {
    expect(executableExtensions(env, true)).toEqual(['.exe', '.cmd', '.bat', '.com'])
    expect(executableExtensions({ PATHEXT: '.CMD;.PS1' }, true)).toEqual(['.cmd'])
    expect(executableExtensions({}, true)).toEqual(['.exe', '.cmd', '.bat', '.com'])
  })

  it('finds an npm .cmd shim in the global folder', async () => {
    const present = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd'])
    const found = await locateHarness(harnessDefinition('claude'), { windows: true, env, isFile: async (path) => present.has(path) })
    expect(found).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd')
  })

  it('prefers PATH order, then .exe over .cmd, then the second program name', async () => {
    const present = new Set(['C:\\tools\\kiro-cli.cmd', 'C:\\tools\\kiro-cli.exe', 'C:\\Program Files\\nodejs\\kiro-cli.exe'])
    const isFile = async (path: string) => present.has(path)
    expect(await locateHarness(harnessDefinition('kiro'), { windows: true, env, isFile })).toBe('C:\\tools\\kiro-cli.exe')
    const old = new Set(['C:\\tools\\claude-code-acp.cmd'])
    expect(await locateHarness(harnessDefinition('claude'), { windows: true, env, isFile: async (path) => old.has(path) }))
      .toBe('C:\\tools\\claude-code-acp.cmd')
  })

  it('reports a missing program as null', async () => {
    expect(await locateHarness(harnessDefinition('codex'), { windows: true, env, isFile: async () => false })).toBeNull()
  })

  it('puts the search folders in front of PATH in the child environment, keeping its spelling', () => {
    const child = childEnvironment({ ...env, EMPTY: undefined }, true)
    expect(Object.keys(child)).toContain('Path')
    expect(Object.keys(child)).not.toContain('PATH')
    expect(Object.keys(child)).not.toContain('EMPTY')
    expect(child.Path.startsWith('C:\\Windows;')).toBe(true)
    expect(child.Path).toContain('C:\\Users\\me\\AppData\\Roaming\\npm')
  })
})

describe('starting a harness without a shell for user text', () => {
  it('spawns an .exe directly', () => {
    expect(buildSpawn('C:\\tools\\kiro-cli.exe', ['acp'], true)).toEqual({ command: 'C:\\tools\\kiro-cli.exe', args: ['acp'] })
  })

  it('wraps a .cmd shim in cmd.exe /d /s /c with verbatim, quoted arguments', () => {
    const spec = buildSpawn('C:\\Users\\me\\AppData\\Roaming\\npm\\codex acp.cmd', ['acp'], true, 'C:\\Windows\\System32\\cmd.exe')
    expect(spec.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\me\\AppData\\Roaming\\npm\\codex acp.cmd" acp"'])
    expect(spec.windowsVerbatimArguments).toBe(true)
  })

  it('falls back to cmd.exe when ComSpec is not an .exe', () => {
    expect(buildSpawn('C:\\a.bat', [], true, 'whatever').command).toBe('cmd.exe')
  })

  it('refuses a path or argument that could change what cmd runs', () => {
    expect(() => buildSpawn('C:\\evil" & calc & ".cmd', [], true)).toThrow()
    expect(() => buildSpawn('C:\\%COMSPEC%\\a.cmd', [], true)).toThrow()
    expect(() => buildSpawn('C:\\a.cmd', ['acp & calc'], true)).toThrow()
    expect(() => buildSpawn('C:\\a.cmd', ['"x"'], true)).toThrow()
  })

  it('does nothing special off Windows', () => {
    expect(buildSpawn('/usr/bin/kiro-cli', ['acp'], false)).toEqual({ command: '/usr/bin/kiro-cli', args: ['acp'] })
  })
})
