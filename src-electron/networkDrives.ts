import { execFile } from 'node:child_process'
import path from 'node:path'
import { setNetworkDrives } from './pathRules'

/* Which drive letters are mapped to network shares, so pathRules can treat
   `X:\pics\a.png` like the `\\nas\pics\a.png` it really is — refused before
   any fs call unless a library folder the user chose lives there. Read from
   `net use` (the drive letter and the `\\` remote are locale-independent),
   in the background: at startup and then at most once a minute when asked.
   Until the first answer the list is empty, and assetGuard's second line of
   defence (a realpath that canonicalises to `\\server\share`) still applies.
   No Electron imports. */

const REFRESH_MS = 60_000

/** Drive letters (upper case) that `net use` lists with a `\\server\share`
    remote, whatever its status column says. */
export function parseNetUse(output: string): string[] {
  const letters = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /(?:^|\s)([A-Za-z]):\s+\\\\[^\\\s]+\\/.exec(line)
    if (match) letters.add(match[1].toUpperCase())
  }
  return [...letters]
}

let lastRun = 0
let running = false

/** Re-reads the mapped drives unless that happened in the last minute. */
export function refreshNetworkDrives(): void {
  if (process.platform !== 'win32' || running || Date.now() - lastRun < REFRESH_MS) return
  running = true
  lastRun = Date.now()
  const net = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe')
  execFile(net, ['use'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
    running = false
    const text = String(stdout ?? '')
    if (!error || text.trim()) setNetworkDrives(parseNetUse(text))
  })
}
