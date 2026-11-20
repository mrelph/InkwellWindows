import { mkdirSync } from 'node:fs'
import nodePath from 'node:path'
import type {
  AgentContext,
  AgentEvent,
  AgentHarnessId,
  AgentHarnessInfo,
  AgentPermissionOption,
  AgentPromptPayload,
  AgentResult,
  AgentSessionState,
  DiffLine
} from '../ipc/contract'
import { ACPClient, type ClientHost, type NoteContext } from './client'
import { AgentFileAccess, MAX_BYTES } from './fileAccess'
import {
  buildSpawn,
  childEnvironment,
  harnessDefinition,
  HARNESS_DEFINITIONS,
  locateHarness,
  type HarnessDefinition
} from './harness'
import { lineDiff } from './lineDiff'
import { canonical, isBelow, isDirectory, isFilesystemRoot, isPlainName, PathSandbox } from './pathSandbox'
import type { ProcessSpec } from './process'

/* The one live agent session and everything around it: which harness, the
   sandbox, the sheets and the open-note buffer round trips. Electron-free (the
   window, settings and file locations come in through AgentEnvironment), so
   the whole flow is tested end to end with a fake agent. Port of InkwellMac
   ACPAgentController.swift + AgentManager.swift. */

export type PermissionPrompt = {
  kind: 'tool' | 'write'
  title: string
  detail: string
  options: AgentPermissionOption[]
  path?: string
  diff?: DiffLine[]
}

export type BufferAnswer = { open: false } | { open: true; content: string } | { open: true; applied: boolean }

/** `draft`: the path is an unsaved draft's stand-in (no file); `docId` names
    that draft exactly when the renderer told us its id. */
export type BufferQuery =
  | { op: 'read'; path: string; draft?: boolean; docId?: string }
  | { op: 'write'; path: string; content: string; draft?: boolean; docId?: string }

export type AgentEnvironment = {
  isEnabled: () => boolean
  getHarness: () => AgentHarnessId
  emit: (event: AgentEvent) => void
  /** The chosen optionId, or null. Never rejects. */
  askPermission: (prompt: PermissionPrompt) => Promise<string | null>
  /** Asks the renderer about an open note. Never rejects; `{ open: false }` when unanswered. */
  askBuffer: (query: BufferQuery) => Promise<BufferAnswer>
  /** Closes any sheet the renderer still shows (their promises resolve null). */
  dismissSheets?: () => void
  /** A write landed on disk (not in an open note's buffer). */
  onFileWritten?: (path: string, created: boolean) => void
  /** A private folder for sessions that have no library folder. */
  fallbackDirectory: () => string
  clientVersion?: string
  home?: string
  /** Replaced in tests: how to start a harness, or null when it is not installed. */
  prepareLaunch?: (harness: HarnessDefinition, cwd: string) => Promise<(ProcessSpec & { title?: string }) | null>
  flushMs?: number
}

const MAX_PROMPT_CHARS = 200_000
const MAX_DIFF_LINES = 4000
const MAX_DIFF_LINE_CHARS = 1000

export const WRITE_ALLOW = 'allow_once'
export const WRITE_DENY = 'deny'

/** The session's folder: the library folder holding the open note, else the
    note's own folder, else the first library folder. Never the home folder or
    a drive root; a private folder when nothing fits. */
export function pickWorkingDirectory(context: AgentContext, home: string, fallback: string): string {
  const windows = process.platform === 'win32'
  const homeReal = canonical(home) ?? home
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  const candidates: string[] = []
  const active = context.activePath
  if (active) {
    const folder = context.roots.find((root) => isBelow(root, active, windows))
    if (folder) candidates.push(folder)
    candidates.push(nodePath.dirname(active))
  }
  candidates.push(...context.roots)
  for (const candidate of candidates) {
    const real = canonical(candidate)
    if (real && isDirectory(real) && !isFilesystemRoot(real, windows) && !same(real, homeReal)) return real
  }
  mkdirSync(fallback, { recursive: true })
  return canonical(fallback) ?? fallback
}

const withMarkdownName = (name: string) => (/\.(md|mdx|markdown)$/i.test(name) ? name : `${name}.md`)

export class AgentController {
  context: AgentContext = { roots: [] }
  private client: ACPClient | null = null
  private generation = 0
  private drafts: string[] = []
  /** Stand-in path of an unsaved draft → the renderer's document id. */
  private draftIds = new Map<string, string>()
  private dismissals = 0
  private sheetChain: Promise<unknown> = Promise.resolve()
  private lastFailure: string | null = null

  constructor(private readonly env: AgentEnvironment) {}

  state(): AgentSessionState {
    if (!this.env.isEnabled()) return { state: 'disabled' }
    if (this.client) return this.client.sessionState()
    return this.lastFailure ? { state: 'failed', message: this.lastFailure } : { state: 'stopped' }
  }

  get session(): ACPClient | null {
    return this.client
  }

  setContext(context: AgentContext): void {
    this.context = context
  }

  async listHarnesses(): Promise<AgentHarnessInfo[]> {
    const enabled = this.env.isEnabled()
    return Promise.all(HARNESS_DEFINITIONS.map(async (harness) => {
      const found = enabled && !this.env.prepareLaunch ? await locateHarness(harness) : null
      return {
        id: harness.id,
        title: harness.title,
        helpUrl: harness.helpUrl,
        installed: found !== null,
        selected: harness.id === this.env.getHarness(),
        ...(found ? { path: found } : {})
      }
    }))
  }

  /** Stops any session and starts a new one with `harness` (default: the chosen one). */
  async newSession(harnessId?: AgentHarnessId): Promise<AgentResult> {
    if (!this.env.isEnabled()) return { ok: false, message: 'The agent is turned off.' }
    const generation = ++this.generation
    this.dismissPermissionRequests()
    const previous = this.client
    this.client = null
    this.drafts = []
    this.draftIds.clear()
    this.lastFailure = null
    this.env.emit({ type: 'reset' })
    void previous?.stop()

    const definition = harnessDefinition(harnessId ?? this.env.getHarness())
    this.env.emit({ type: 'state', state: { state: 'starting', harness: definition.id } })
    const cwd = pickWorkingDirectory(this.context, this.env.home ?? process.env.USERPROFILE ?? process.env.HOME ?? '', this.env.fallbackDirectory())
    let launch: (ProcessSpec & { title?: string }) | null
    try {
      launch = await this.prepare(definition, cwd)
    } catch (error) {
      launch = null
      if (generation === this.generation) return this.fail(`Could not start ${definition.title}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (generation !== this.generation || !this.env.isEnabled()) return { ok: false, message: 'Superseded by a newer session.' }
    if (!launch) return this.fail(`${definition.title} is not installed`)

    const client = new ACPClient({
      harness: definition.id,
      title: launch.title ?? definition.title,
      launch,
      files: this.makeFileAccess(),
      host: this.makeHost(),
      clientVersion: this.env.clientVersion,
      flushMs: this.env.flushMs
    })
    this.client = client
    await client.start()
    if (generation !== this.generation) {
      // Replaced while starting.
      if (this.client !== client) void client.stop()
      return { ok: false, message: 'Superseded by a newer session.' }
    }
    if (client.state !== 'ready') return { ok: false, message: client.failure || 'The agent did not start.' }
    if (this.sandbox().roots.length === 0) {
      client.addNotice("Inkwell shares no folders with the agent, so it can't create notes. Add a folder to the library (Ctrl+Shift+O).")
    }
    return { ok: true }
  }

  /** Sends a prompt, starting a session first if there is none. The first
      prompt of a session carries the open note when asked to. */
  async prompt(payload: AgentPromptPayload): Promise<AgentResult> {
    if (!this.env.isEnabled()) return { ok: false, message: 'The agent is turned off.' }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return { ok: false, message: 'Type a message first.' }
    if (text.length > MAX_PROMPT_CHARS) return { ok: false, message: 'That message is too long.' }
    if (this.client?.state === 'prompting') return { ok: false, message: 'The agent is still working on the last message.' }
    if (this.client?.state === 'starting') return { ok: false, message: 'The agent is still starting.' }
    if (!this.client || this.client.state !== 'ready') {
      const started = await this.newSession()
      if (!started.ok) return started
    }
    const client = this.client
    if (!client || client.state !== 'ready') return { ok: false, message: 'The agent is not connected.' }
    let note: NoteContext | undefined
    if (payload.includeNote === true && !client.hasPrompted && payload.note) note = this.noteContext(payload.note)
    await client.prompt(text, note)
    return { ok: true }
  }

  cancel(): void {
    this.client?.cancel()
    this.dismissPermissionRequests()
  }

  async stop(): Promise<void> {
    const client = this.client
    this.generation++
    this.dismissPermissionRequests()
    if (!client) return
    this.client = null
    this.drafts = []
    this.draftIds.clear()
    await client.stop()
    this.env.emit({ type: 'state', state: this.state() })
  }

  /** Kills the process tree now. For window close and quit. */
  forceKill(): void {
    this.generation++
    this.dismissPermissionRequests()
    this.client?.forceKill()
    this.client = null
  }

  /** What the renderer needs to redraw after a reload: the whole transcript. */
  replay(): void {
    if (!this.client) return
    this.env.emit({ type: 'reset' })
    for (const entry of this.client.transcript.entries) this.env.emit({ type: 'entry', entry: structuredClone(entry) })
    this.env.emit({ type: 'state', state: this.state() })
  }

  /** Answers every open sheet `cancelled` and drops the queued ones. */
  dismissPermissionRequests(): void {
    this.dismissals++
    this.env.dismissSheets?.()
  }

  /** The sandbox now: library folders and the open note's folder, plus the
      stand-in paths of unsaved drafts. */
  sandbox(): PathSandbox {
    const roots = [...this.context.roots]
    if (this.context.activePath) roots.push(nodePath.dirname(this.context.activePath))
    return new PathSandbox(roots, { files: this.drafts, home: this.env.home })
  }

  private fail(message: string): AgentResult {
    this.lastFailure = message
    this.env.emit({ type: 'state', state: { state: 'failed', message } })
    return { ok: false, message }
  }

  private async prepare(harness: HarnessDefinition, cwd: string): Promise<(ProcessSpec & { title?: string }) | null> {
    if (this.env.prepareLaunch) return this.env.prepareLaunch(harness, cwd)
    const executable = await locateHarness(harness)
    if (!executable) return null
    const windows = process.platform === 'win32'
    const spawn = buildSpawn(executable, harness.arguments, windows, process.env.ComSpec)
    return { ...spawn, cwd, env: childEnvironment(process.env, windows) }
  }

  /** An unsaved draft has no file, so the agent is told it is in the session
      folder under its name. Reads and writes there go to the draft in Inkwell,
      never to disk. */
  private noteContext(note: AgentPromptPayload['note'] & object): NoteContext | undefined {
    if (typeof note.name !== 'string' || typeof note.content !== 'string' || note.content.length > MAX_BYTES) return undefined
    const name = note.name.slice(0, 200)
    const cwd = this.client?.cwd
    let path = typeof note.path === 'string' && note.path ? note.path : undefined
    let unsaved = false
    if (note.unsaved === true && !path && cwd) {
      const fileName = withMarkdownName(name)
      const candidate = nodePath.join(cwd, fileName)
      if (isPlainName(fileName, process.platform === 'win32') && !pathExists(candidate)) {
        path = candidate
        unsaved = true
        this.drafts = [candidate]
        this.draftIds.clear()
        if (typeof note.docId === 'string' && note.docId && note.docId.length <= 500) this.draftIds.set(candidate, note.docId)
      }
    }
    return { name: unsaved ? withMarkdownName(name) : name, path, content: note.content, unsaved }
  }

  private makeFileAccess(): AgentFileAccess {
    return new AgentFileAccess({
      sandbox: () => this.sandbox(),
      openBuffer: async (path, virtual) => {
        const answer = await this.env.askBuffer({ op: 'read', path, ...this.draftOf(path, virtual) })
        return answer.open && 'content' in answer ? answer.content : null
      },
      applyToBuffer: async (path, content) => {
        const answer = await this.env.askBuffer({ op: 'write', path, content, ...this.draftOf(path, this.drafts.includes(path)) })
        return answer.open && 'applied' in answer && answer.applied
      },
      confirmWrite: (request) => this.confirmWrite(request),
      didWriteFile: (path, created) => this.env.onFileWritten?.(path, created)
    })
  }

  /** What a buffer request says about an unsaved draft's stand-in path. */
  private draftOf(path: string, virtual: boolean): { draft?: boolean; docId?: string } {
    if (!virtual) return {}
    const docId = this.draftIds.get(path)
    return docId ? { draft: true, docId } : { draft: true }
  }

  private makeHost(): ClientHost {
    return {
      requestPermission: ({ title, detail, options }) =>
        this.serially(() => this.env.askPermission({ kind: 'tool', title, detail, options })),
      dismissPermissionRequests: () => this.dismissPermissionRequests(),
      onEntries: (entries) => { for (const entry of entries) this.env.emit({ type: 'entry', entry }) },
      onState: (state) => this.env.emit({ type: 'state', state })
    }
  }

  /** One sheet at a time, in the order the agent asked. A cancel drops the
      ones still waiting (they answer null). */
  private serially(body: () => Promise<string | null>): Promise<string | null> {
    const asked = this.dismissals
    const run = this.sheetChain.then(async () => {
      if (asked !== this.dismissals || this.client?.state !== 'prompting') return null
      const answer = await body()
      return asked === this.dismissals ? answer : null
    })
    this.sheetChain = run.catch(() => undefined)
    return run
  }

  private async confirmWrite(request: { path: string; old: string; new: string; openNote: boolean; creates: boolean }): Promise<boolean> {
    const asked = this.dismissals
    const run = this.sheetChain.then(async () => {
      if (asked !== this.dismissals || this.client?.state !== 'prompting') return null
      const normalize = (text: string) => text.replace(/\r\n/g, '\n')
      const diff = lineDiff(normalize(request.old), normalize(request.new)).slice(0, MAX_DIFF_LINES)
        .map((line): DiffLine => ({ op: line.op, text: line.text.slice(0, MAX_DIFF_LINE_CHARS) }))
      const answer = await this.env.askPermission({
        kind: 'write',
        title: 'Let the agent write this file?',
        detail: request.openNote
          ? 'This changes the open note in Inkwell, not the file on disk. Undo reverts it.'
          : request.creates ? 'This creates a new file on disk.' : 'This replaces the file on disk.',
        options: [
          { optionId: WRITE_DENY, name: 'Deny', kind: 'reject_once' },
          { optionId: WRITE_ALLOW, name: 'Allow Once', kind: 'allow_once' }
        ],
        path: request.path,
        diff
      })
      return asked === this.dismissals ? answer : null
    })
    this.sheetChain = run.catch(() => undefined)
    return (await run) === WRITE_ALLOW
  }
}

const pathExists = (path: string): boolean => canonical(path) !== null
