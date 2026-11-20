import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import nodePath from 'node:path'
import type { AgentHarnessId } from '../ipc/contract'
import { isAbsolutePath } from './pathSandbox'

/* The agent programs Inkwell knows how to start, and how to find and launch
   them on Windows. Each one speaks ACP on its stdin and stdout.

   Finding: the executable is resolved on PATH with PATHEXT (.exe, .cmd, .bat),
   then in the usual per-user install folders (npm's global folder is not
   always on the PATH an Electron app inherits).

   Launching: a real .exe is spawned directly. npm's global shims are .cmd
   files, and Node refuses to spawn those without a shell (CVE-2024-27980), so
   they run through `cmd.exe /d /s /c "<exe>" <args>` with the command line
   built here from the located path and fixed arguments only. User text never
   goes near a shell: prompts travel as JSON over stdin. */

export type HarnessDefinition = {
  id: AgentHarnessId
  title: string
  /** Program names to look for, best first. */
  executables: string[]
  arguments: string[]
  helpUrl: string
}

export const HARNESS_DEFINITIONS: HarnessDefinition[] = [
  { id: 'kiro', title: 'Kiro CLI', executables: ['kiro-cli'], arguments: ['acp'], helpUrl: 'https://kiro.dev/docs/cli/' },
  { id: 'codex', title: 'Codex', executables: ['codex-acp'], arguments: [], helpUrl: 'https://github.com/zed-industries/codex-acp' },
  // The adapter was published as claude-code-acp, then renamed.
  {
    id: 'claude',
    title: 'Claude Code',
    executables: ['claude-agent-acp', 'claude-code-acp'],
    arguments: [],
    helpUrl: 'https://github.com/agentclientprotocol/claude-agent-acp'
  }
]

export const harnessDefinition = (id: AgentHarnessId): HarnessDefinition =>
  HARNESS_DEFINITIONS.find((entry) => entry.id === id) ?? HARNESS_DEFINITIONS[0]

export type Env = Record<string, string | undefined>

/** The value of an environment variable, whatever its case (Windows is
    case-insensitive: `Path`, `PATH`). */
export function envValue(env: Env, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** The executable extensions to try, in preference order: PATHEXT limited to
    the kinds Inkwell can start. */
export function executableExtensions(env: Env, windows: boolean): string[] {
  if (!windows) return ['']
  const preferred = ['.exe', '.cmd', '.bat', '.com']
  const listed = (envValue(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  const allowed = preferred.filter((entry) => listed.includes(entry))
  return allowed.length ? allowed : preferred
}

/** PATH first, then the per-user install folders. De-duplicated, in order. */
export function searchFolders(env: Env, windows: boolean): string[] {
  const separator = windows ? ';' : ':'
  const fromPath = (envValue(env, 'PATH', windows) ?? '').split(separator)
  const home = envValue(env, windows ? 'USERPROFILE' : 'HOME', windows) ?? ''
  const extras: string[] = []
  if (windows) {
    const appData = envValue(env, 'APPDATA', true)
    const localAppData = envValue(env, 'LOCALAPPDATA', true)
    if (appData) extras.push(nodePath.win32.join(appData, 'npm'))
    if (home) extras.push(nodePath.win32.join(home, '.local', 'bin'), nodePath.win32.join(home, '.cargo', 'bin'), nodePath.win32.join(home, '.bun', 'bin'))
    if (localAppData) {
      extras.push(
        nodePath.win32.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
        nodePath.win32.join(localAppData, 'Programs', 'Kiro CLI'),
        nodePath.win32.join(localAppData, 'pnpm')
      )
    }
  } else if (home) {
    extras.push(`${home}/.local/bin`, `${home}/.toolbox/bin`, '/opt/homebrew/bin', '/usr/local/bin')
  }
  const seen = new Set<string>()
  const folders: string[] = []
  for (const folder of [...fromPath, ...extras]) {
    const clean = folder.trim().replace(/^"(.*)"$/, '$1')
    // A relative entry would resolve against the app's working directory.
    if (!clean || !isAbsolutePath(clean, windows)) continue
    const key = windows ? clean.toLowerCase() : clean
    if (seen.has(key)) continue
    seen.add(key)
    folders.push(clean)
  }
  return folders
}

export type LocateOptions = {
  windows?: boolean
  env?: Env
  /** Replaced in tests. */
  isFile?: (path: string) => Promise<boolean>
}

const defaultIsFile = (windows: boolean) => async (path: string) => {
  try {
    if (!(await stat(path)).isFile()) return false
    if (!windows) await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The full path of the first program found, or null. */
export async function locateHarness(harness: HarnessDefinition, options: LocateOptions = {}): Promise<string | null> {
  const windows = options.windows ?? process.platform === 'win32'
  const env = options.env ?? process.env
  const isFile = options.isFile ?? defaultIsFile(windows)
  const join = windows ? nodePath.win32.join : nodePath.posix.join
  const extensions = executableExtensions(env, windows)
  const folders = searchFolders(env, windows)
  for (const name of harness.executables) {
    for (const folder of folders) {
      for (const extension of extensions) {
        const candidate = join(folder, name + extension)
        if (await isFile(candidate)) return candidate
      }
    }
  }
  return null
}

/** The child's environment: the app's own, with the search folders in front
    of PATH so a script that runs `node` finds it too. */
export function childEnvironment(base: Env, windows: boolean): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  const pathKey = windows ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path' : 'PATH'
  env[pathKey] = searchFolders(base, windows).join(windows ? ';' : ':')
  return env
}

export type SpawnSpec = {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** Characters that could change what cmd.exe runs even inside quotes. */
const UNSAFE_FOR_CMD = /["%\r\n\u0000]/
const SAFE_ARGUMENT = /^[A-Za-z0-9._-]+$/

/** How to start `executable args...`. A .cmd or .bat goes through cmd.exe with
    a command line built only from the located path and fixed arguments. */
export function buildSpawn(executable: string, args: string[], windows: boolean, comSpec?: string): SpawnSpec {
  if (!windows || !/\.(cmd|bat)$/i.test(executable)) return { command: executable, args }
  if (UNSAFE_FOR_CMD.test(executable) || !args.every((arg) => SAFE_ARGUMENT.test(arg))) {
    throw new Error('That program path cannot be started safely')
  }
  const line = ['"' + executable + '"', ...args].join(' ')
  // /s strips the outer pair of quotes, so the whole line is wrapped once more.
  return {
    command: comSpec && /\.exe$/i.test(comSpec) ? comSpec : 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true
  }
}
