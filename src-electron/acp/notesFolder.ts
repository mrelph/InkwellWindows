import { mkdirSync } from 'node:fs'
import nodePath from 'node:path'
import { isNetworkPath } from '../pathRules'
import { canonical, isDirectory } from './pathSandbox'

/* The folder Inkwell offers when the agent has nowhere to save (Mac
   `NotesFolder`, AgentFileAccess.swift). Electron-free so it is unit tested. */

/** `<documents>\Inkwell`: the folder the offer's "Create" button makes. */
export function defaultNotesFolderPath(documents: string): string {
  return nodePath.join(documents, 'Inkwell')
}

/** Makes the folder if it is missing. Its real path, or null when there is no
    local folder there afterwards (a file in the way, no permission, a network
    path). A network path is refused lexically, before any fs call. */
export function createNotesFolder(target: string): string | null {
  if (!nodePath.isAbsolute(target) || isNetworkPath(target)) return null
  try {
    mkdirSync(target, { recursive: true })
  } catch {
    /* judged by what is on disk below */
  }
  const real = canonical(target)
  if (!real || isNetworkPath(real) || !isDirectory(real)) return null
  return real
}
