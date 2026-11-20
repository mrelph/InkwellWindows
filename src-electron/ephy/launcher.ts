import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/* Starting the CLI. Port of Mac `ProcessLauncher`: an argument array (never a
   shell string), stdin from memory, both pipes drained, a small fixed
   environment, a neutral working folder and a hard timeout. Output is
   returned to the caller and never logged. */

export type RunResult = {
  status: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Starts a program. Tests swap in a fake that counts launches. `null` means
    the program could not be started at all (missing, not executable). */
export type Launcher = (
  executable: string,
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number
) => Promise<RunResult | null>

/** Hard cap on what one run may print, so a runaway child cannot fill memory. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

const WINDOWS_ENV_KEYS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN',
  'USERDNSDOMAIN', 'LOGONSERVER', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'HTTP_PROXY', 'HTTPS_PROXY',
  'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
]
const POSIX_ENV_KEYS = ['USER', 'LOGNAME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']

/** A small, fixed environment: the CLI's own folder first on PATH, no upgrade
    nag, and not tagged as an agent (a person is typing). Mac
    `ProcessLauncher.environment(for:)`. */
export function buildEnvironment(
  executable: string,
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const pick = (name: string): string | undefined => {
    if (platform !== 'win32') return source[name]
    const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : source[key]
  }
  const env: Record<string, string> = {}
  for (const key of platform === 'win32' ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS) {
    const value = pick(key)
    if (value !== undefined) env[key] = value
  }
  const home = platform === 'win32' ? pick('USERPROFILE') ?? os.homedir() : pick('HOME') ?? os.homedir()
  env.HOME = home
  const delimiter = platform === 'win32' ? ';' : ':'
  const folder = (platform === 'win32' ? path.win32 : path.posix).dirname(executable)
  const inherited = pick('PATH')
  env[platform === 'win32' ? 'Path' : 'PATH'] = [folder, ...(inherited ? [inherited] : [])].join(delimiter)
  env.LANG = 'en_US.UTF-8'
  env.EPHY_NO_UPGRADE_CHECK = '1'
  env.EPHY_VIA_AGENT = '0'
  return env
}

/* ---- .cmd / .bat shims ------------------------------------------------- */

/* Node refuses to start a .cmd/.bat directly (EINVAL since the 2024 CVE
   fix), so a shim runs through `cmd.exe /d /s /c "<line>"`. cmd re-parses the
   whole line, which makes quoting the entire risk. Arguments are therefore
   reduced to characters that cannot mean anything to cmd: the CLI's own flags
   and validated ids are already plain, and a title (the only free text) loses
   the few characters cmd would act on. The note's content is never an
   argument; it travels on stdin. */

const CMD_UNSAFE = /[%^&|<>"!\r\n\0`]/g

/** What cmd.exe could interpret inside a quoted argument is replaced by a
    space; the rest is kept. */
export function sanitizeCmdArgument(value: string): string {
  return value.replace(CMD_UNSAFE, ' ')
}

/** The shim's own path must be plain too; otherwise it is not started. */
export function isSafeCmdPath(file: string): boolean {
  return !/[%^&|<>"!\r\n\0`]/.test(file)
}

/** `"C:\path\ephy.cmd" "post" "list" "--json"`, wrapped for `cmd /s /c`. */
export function cmdCommandLine(file: string, args: readonly string[]): string {
  const quoted = [file, ...args.map(sanitizeCmdArgument)].map((part) => `"${part}"`).join(' ')
  return `"${quoted}"`
}

const isShim = (file: string) => /\.(cmd|bat)$/i.test(file)

type Invocation = { file: string; args: string[]; verbatim: boolean }

/** How to start `executable`: directly, or through cmd.exe for a shim. Null
    when a shim's path is not safe to hand to cmd. */
export function invocationFor(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform): Invocation | null {
  if (platform === 'win32' && isShim(executable)) {
    if (!isSafeCmdPath(executable)) return null
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', cmdCommandLine(executable, args)], verbatim: true }
  }
  return { file: executable, args: [...args], verbatim: false }
}

/** Stops the child and, on Windows, whatever the shim started under it. */
function killTree(pid: number | undefined, kill: () => void): void {
  kill()
  if (pid !== undefined && process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  }
}

export const runProcess: Launcher = (executable, args, stdin, timeoutMs) =>
  new Promise((resolve) => {
    const invocation = invocationFor(executable, args)
    if (!invocation) return resolve(null)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let timedOut = false
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.file, invocation.args, {
        env: buildEnvironment(executable),
        // Neutral folder: `artifact new` reads `.ephy/project` above the cwd.
        cwd: os.homedir(),
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
        shell: false
      })
    } catch {
      return resolve(null)
    }

    const finish = (result: RunResult | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, () => child.kill())
      // If the child ignores the polite stop, do not wait for it forever.
      setTimeout(() => {
        killTree(child.pid, () => child.kill('SIGKILL'))
        finish({ status: -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut: true })
      }, 2000).unref()
    }, timeoutMs)

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        killTree(child.pid, () => child.kill())
        return
      }
      sink.push(chunk)
    }
    child.stdout?.on('data', collect(stdout))
    child.stderr?.on('data', collect(stderr))
    // A child that exits before reading stdin must not take Inkwell down.
    child.stdin?.on('error', () => undefined)
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      finish({
        status: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut
      })
    })
    if (stdin !== undefined && child.stdin) child.stdin.end(Buffer.from(stdin, 'utf8'))
  })
