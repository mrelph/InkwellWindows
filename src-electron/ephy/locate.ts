import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* Finding the `ephy` CLI. Port of Mac `EphyLocator.find`: the usual fixed
   place first (`~/.toolbox/bin/ephy`), then the search path. Mac also asks a
   login shell because a GUI app does not inherit the shell's PATH; a Windows
   app inherits the user's PATH, so scanning it (with PATHEXT) is the
   equivalent and no shell is started. Returns an absolute path to a file the
   launcher knows how to run (.exe, .com, or a .cmd/.bat shim). */

/** Extensions the launcher can start. A PATHEXT entry outside this list
    (.ps1 is not in PATHEXT anyway, .vbs, .js, .msc) is never picked. */
export const RUNNABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

export type LocateOptions = {
  home?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** True when the path is an existing regular file. */
  isFile?: (candidate: string) => boolean
}

const defaultIsFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

const envValue = (env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined => {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** PATHEXT filtered to what can run, in the order the system lists them. */
export function runnableExtensions(pathext: string | undefined): string[] {
  const listed = (pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => (RUNNABLE_EXTENSIONS as readonly string[]).includes(extension))
  return listed.length > 0 ? Array.from(new Set(listed)) : ['.exe', '.cmd']
}

/** The candidate list, in order: `%USERPROFILE%\.toolbox\bin`, then each PATH
    folder; every folder tried with each runnable extension. */
export function candidates(options: LocateOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32' ? runnableExtensions(envValue(env, 'PATHEXT', platform)) : ['']
  const folders = [join(home, '.toolbox', 'bin')]
  for (const entry of (envValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1')
    if (folder.length > 0 && (platform === 'win32' ? path.win32.isAbsolute(folder) : path.posix.isAbsolute(folder))) folders.push(folder)
  }
  const out: string[] = []
  for (const folder of folders) {
    for (const extension of extensions) {
      const candidate = join(folder, `ephy${extension}`)
      if (!out.includes(candidate)) out.push(candidate)
    }
  }
  return out
}

/** The first candidate that exists, or null. */
export function findEphy(options: LocateOptions = {}): string | null {
  const isFile = options.isFile ?? defaultIsFile
  for (const candidate of candidates(options)) {
    if (isFile(candidate)) return candidate
  }
  return null
}
