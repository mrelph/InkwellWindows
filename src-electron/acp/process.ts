import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { SpawnSpec } from './harness'

/* One agent child process with its stdio pipes. No shell of our own: the
   program and its arguments go straight to spawn (a .cmd shim is wrapped by
   harness.buildSpawn). No sockets: stdio only. Port of InkwellMac
   AgentProcess.swift. */

export type ProcessSpec = SpawnSpec & {
  cwd: string
  env: Record<string, string>
}

const ERROR_TAIL_BYTES = 8192

/** Kills the process and everything it started. A .cmd shim leaves cmd.exe
    and node as parent and child, and killing only the parent would orphan
    the agent. */
export function killTree(pid: number, sync = false): void {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F']
    try {
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 3000 })
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined).unref()
    } catch {
      /* already gone */
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

export class AgentProcess {
  private child: ChildProcess | null = null
  private errorBytes = Buffer.alloc(0)
  private inputClosed = false
  private exited = false
  private exitWaiters: Array<() => void> = []

  constructor(private readonly spec: ProcessSpec) {}

  get isRunning(): boolean {
    return this.child !== null && !this.exited
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** The last few KB the agent wrote to stderr, for error messages. */
  get errorTail(): string {
    return this.errorBytes.toString('utf8')
  }

  /** Starts the process. `onOutput` gets stdout bytes in order; `onExit` runs
      once, after the last stdout chunk, with the exit status (-1 when the
      program could not start). */
  start(onOutput: (data: Buffer) => void, onExit: (status: number) => void): void {
    let reported = false
    const finish = (status: number) => {
      if (reported) return
      reported = true
      this.exited = true
      for (const waiter of this.exitWaiters.splice(0)) waiter()
      onExit(status)
    }
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: this.spec.windowsVerbatimArguments,
      shell: false
    })
    this.child = child
    child.stdout?.on('data', (data: Buffer) => onOutput(data))
    child.stderr?.on('data', (data: Buffer) => {
      this.errorBytes = Buffer.concat([this.errorBytes, data])
      if (this.errorBytes.length > ERROR_TAIL_BYTES) this.errorBytes = this.errorBytes.subarray(this.errorBytes.length - ERROR_TAIL_BYTES)
    })
    // A write to a pipe whose reader died must fail quietly, not crash the app.
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => {
      const message = Buffer.from(`${error.message}\n`)
      this.errorBytes = Buffer.concat([this.errorBytes, message])
      finish(-1)
    })
    // `close` fires after the stdio streams end, so the last output has landed.
    child.on('close', (code, signal) => finish(code ?? (signal ? -2 : -1)))
  }

  write(line: string): void {
    const stdin = this.child?.stdin
    if (!stdin || this.inputClosed || stdin.destroyed || !stdin.writable) return
    stdin.write(line)
  }

  /** Closes stdin. Well-behaved agents exit when their input ends. */
  closeInput(): void {
    if (this.inputClosed) return
    this.inputClosed = true
    try {
      this.child?.stdin?.end()
    } catch {
      /* already closed */
    }
  }

  /** Ends the process: close stdin and wait `graceMs`, then terminate the
      whole tree and wait again. Resolves once it has exited, or after a last
      short wait. Safe to call more than once. */
  async stopAndWait(graceMs = 1000): Promise<void> {
    if (!this.child || this.exited) return
    this.closeInput()
    if (await this.waitForExit(graceMs)) return
    this.terminate()
    if (await this.waitForExit(graceMs)) return
    this.terminate()
    await this.waitForExit(3000)
  }

  /** Kills the process now, without waiting. For quit and window close. */
  kill(sync = false): void {
    if (!this.child || this.exited) return
    this.closeInput()
    this.terminate(sync)
  }

  private terminate(sync = false): void {
    const pid = this.child?.pid
    if (pid === undefined || this.exited) return
    killTree(pid, sync)
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(done)
        if (index >= 0) this.exitWaiters.splice(index, 1)
        resolve(false)
      }, ms)
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.exitWaiters.push(done)
    })
  }
}
