import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNELS } from './ipc/contract'
import { COMMAND_IDS } from '../src/app/commands'
import { SHORTCUTS, acceleratorMap, matchShortcut, type Shortcut } from '../src/app/shortcuts'

const preload = readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')

/* Every channel literal the preload hands to ipcRenderer, directly or via the
   `subscribe` helper. */
const preloadChannels = () => {
  const found = new Set<string>()
  const patterns = [
    /ipcRenderer\s*\.\s*(?:invoke|on|once|send|sendSync|removeListener|removeAllListeners)\(\s*(['"`])([^'"`]+)\1/g,
    /subscribe(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1/g
  ]
  for (const pattern of patterns) for (const match of preload.matchAll(pattern)) found.add(match[2])
  return found
}

describe('IPC contract integrity', () => {
  const values = Object.values(CHANNELS) as string[]

  it('CHANNELS values are unique and well-formed', () => {
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) expect(value).toMatch(/^[a-z]+:[a-z-]+$/)
  })

  it('every CHANNELS value appears in preload.ts', () => {
    const missing = values.filter((value) => !preload.includes(`'${value}'`) && !preload.includes(`"${value}"`))
    expect(missing).toEqual([])
  })

  it('every channel literal used by preload.ts is a CHANNELS value', () => {
    const used = preloadChannels()
    expect(used.size).toBeGreaterThan(20)
    expect([...used].filter((channel) => !values.includes(channel))).toEqual([])
  })

  it('preload imports nothing local at runtime (sandbox rule)', () => {
    const runtimeImports = [...preload.matchAll(/^import\s+(?!type\b)[^\n]*from\s+['"](\.[^'"]*)['"]/gm)]
    expect(runtimeImports.map((m) => m[1])).toEqual([])
  })

  it('the renderer cannot enable the agent or Ephy: it may only request it', () => {
    for (const channel of ['agent:set-enabled', 'ephy:set-enabled']) {
      expect(values).not.toContain(channel)
      expect(preload).not.toContain(channel)
    }
    expect(preload).not.toMatch(/setEnabled/)
    /* Asking is allowed (main confirms natively, ipc/settingsRequests.ts), and
       so is turning one off; neither carries a payload the page chooses. */
    for (const channel of ['agent:request-enable', 'agent:disable', 'ephy:request-enable', 'ephy:disable']) {
      expect(values).toContain(channel)
      expect(preload).toContain(`ipcRenderer.invoke('${channel}')`)
    }
    // The read side and the change events stay.
    for (const channel of ['agent:get-enabled', 'agent:enabled-changed', 'ephy:get-enabled', 'ephy:enabled-changed']) {
      expect(values).toContain(channel)
    }
  })

  it('every main-process IPC handler goes through the sender check (ipcGuard.ts)', () => {
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(full)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
    })
    const direct = sources(__dirname)
      .filter((file) => path.basename(file) !== 'ipcGuard.ts')
      .filter((file) => /ipcMain\s*\.\s*(handle|on|once|handleOnce)\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(__dirname, file))
    expect(direct).toEqual([])
  })
})

describe('commands and shortcuts', () => {
  const overlaps = (a: Shortcut, b: Shortcut) => {
    const compatible = (x: boolean | 'any', y: boolean | 'any') => x === 'any' || y === 'any' || x === y
    return a.key === b.key && compatible(a.ctrl, b.ctrl) && compatible(a.shift, b.shift) && compatible(a.alt, b.alt)
  }

  it('COMMAND_IDS has no duplicates', () => {
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length)
  })

  it('every shortcut targets a known command', () => {
    for (const shortcut of SHORTCUTS) expect(COMMAND_IDS as readonly string[]).toContain(shortcut.id)
  })

  it('each command has at most one accelerator (alternates carry none)', () => {
    const perCommand = new Map<string, string[]>()
    for (const shortcut of SHORTCUTS) {
      if (shortcut.accelerator) perCommand.set(shortcut.id, [...(perCommand.get(shortcut.id) ?? []), shortcut.accelerator])
    }
    for (const [id, accelerators] of perCommand) expect(accelerators, id).toHaveLength(1)
  })

  it('no two shortcut rows share an exact binding', () => {
    const seen = new Set<string>()
    for (const s of SHORTCUTS) {
      const signature = `${s.key}|${s.ctrl}|${s.shift}|${s.alt}`
      expect(seen.has(signature), signature).toBe(false)
      seen.add(signature)
    }
  })

  it('no two accelerators collide across commands', () => {
    const owners = new Map<string, string>()
    for (const shortcut of SHORTCUTS) {
      if (!shortcut.accelerator) continue
      const key = shortcut.accelerator.toLowerCase()
      expect(owners.get(key), shortcut.accelerator).toBeUndefined()
      owners.set(key, shortcut.id)
    }
  })

  it('no two different commands can match the same key event', () => {
    const conflicts: string[] = []
    SHORTCUTS.forEach((a, i) => SHORTCUTS.slice(i + 1).forEach((b) => {
      if (a.id !== b.id && overlaps(a, b)) conflicts.push(`${a.id} vs ${b.id}`)
    }))
    expect(conflicts).toEqual([])
  })

  it('matchShortcut resolves the documented Windows bindings', () => {
    const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}) =>
      matchShortcut({ key: k, ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt }, false)?.id
    expect(key('o', { ctrl: true })).toBe('open')
    expect(key('O', { ctrl: true, shift: true })).toBe('addFolder')
    expect(key('s', { ctrl: true })).toBe('save')
    expect(key('S', { ctrl: true, shift: true })).toBe('saveAs')
    expect(key('F3')).toBe('findNext')
    expect(key('F3', { shift: true })).toBe('findPrevious')
    expect(key('+', { ctrl: true, shift: true })).toBe('zoomIn')
    expect(key('=', { ctrl: true })).toBe('zoomIn')
    expect(key('e', { ctrl: true })).toBe('useSelectionForFind')
    expect(key('e', { ctrl: true, shift: true })).toBe('ephyOpen')
    expect(key('a', { ctrl: true, alt: true })).toBe('toggleAgentPanel')
    expect(key('x', { ctrl: true })).toBeUndefined()
  })

  it('Ctrl+Delete is skipped inside text fields', () => {
    const event = { key: 'Delete', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(matchShortcut(event, false)?.id).toBe('trash')
    expect(matchShortcut(event, true)).toBeNull()
  })

  it('acceleratorMap picks the first accelerator and omits alternates', () => {
    const map = acceleratorMap()
    expect(map.zoomIn).toBe('CmdOrCtrl+=')
    expect(map.save).toBe('CmdOrCtrl+S')
    expect(map.escape).toBeUndefined()
  })
})
