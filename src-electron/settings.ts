import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentHarnessId } from './ipc/contract'

/* App preferences that are not part of the library: integration toggles and
   the like. Kept apart from library.json so a mangled library never resets a
   preference and vice versa. Same posture as state.ts — a file the user can
   open and mangle, so every field is re-validated and writes go through a temp
   file. Reads are synchronous from an in-memory copy, so the `isXEnabled()`
   getters the menu calls are plain functions. */

export type Settings = {
  /** Integrations ▸ Agent. Off by default; while off nothing is started. */
  agentEnabled: boolean
  agentHarness: AgentHarnessId
  /** Send the open note with the first prompt of a session. */
  agentIncludeNote: boolean
  /** Integrations ▸ Ephy. Off by default; while off no process is started. */
  ephyEnabled: boolean
  /** Daily update check. INKWELL_NO_UPDATE_CHECK still wins when set. */
  autoUpdateCheck: boolean
  /** Check spelling while typing. */
  spellcheck: boolean
}

const DEFAULTS: Settings = {
  agentEnabled: false,
  agentHarness: 'kiro',
  agentIncludeNote: true,
  ephyEnabled: false,
  autoUpdateCheck: true,
  spellcheck: true
}

const HARNESSES: AgentHarnessId[] = ['kiro', 'codex', 'claude']

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

let current: Settings | null = null

const sanitize = (value: unknown): Settings => {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const bool = (key: keyof Settings) => typeof record[key] === 'boolean' ? record[key] as boolean : DEFAULTS[key] as boolean
  return {
    agentEnabled: bool('agentEnabled'),
    agentHarness: HARNESSES.includes(record.agentHarness as AgentHarnessId) ? record.agentHarness as AgentHarnessId : DEFAULTS.agentHarness,
    agentIncludeNote: bool('agentIncludeNote'),
    ephyEnabled: bool('ephyEnabled'),
    autoUpdateCheck: bool('autoUpdateCheck'),
    spellcheck: bool('spellcheck')
  }
}

/** The whole settings object. Loaded lazily (synchronously, once). */
export function getSettings(): Settings {
  if (current) return current
  try {
    current = sanitize(JSON.parse(readFileSync(settingsFile(), 'utf8')))
  } catch {
    current = { ...DEFAULTS }
  }
  return current
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return getSettings()[key]
}

type SettingListener = (key: keyof Settings) => void
const listeners = new Set<SettingListener>()

/** Called after a setting actually changes, whoever changed it (a menu
    checkbox, the context menu, a panel's IPC call). main.ts uses it to push
    the `*-changed` events to the renderer; menu.ts to rebuild. */
export function onSettingChange(listener: SettingListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Updates one setting in memory immediately and persists it in the background. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
  const before = getSettings()[key]
  current = sanitize({ ...getSettings(), [key]: value })
  void persist(current)
  if (current[key] !== before) {
    for (const listener of [...listeners]) {
      try {
        listener(key)
      } catch (error) {
        console.warn('A settings listener failed', error)
      }
    }
  }
  return current[key]
}

let writing: Promise<void> = Promise.resolve()

function persist(next: Settings): Promise<void> {
  /* Serialised so two quick toggles cannot interleave their temp-file renames. */
  writing = writing.then(async () => {
    const target = settingsFile()
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(`${target}.tmp`, JSON.stringify(next, null, 2), 'utf8')
      await rename(`${target}.tmp`, target)
    } catch {
      /* A preference that fails to persist is re-asked next launch; never fatal. */
    }
  })
  return writing
}
