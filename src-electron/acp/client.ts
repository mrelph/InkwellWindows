import { pathToFileURL } from 'node:url'
import type { AgentHarnessId, AgentSessionState, AgentTranscriptEntry } from '../ipc/contract'
import type { AgentFileAccess } from './fileAccess'
import { AgentProcess, type ProcessSpec } from './process'
import { asInt, asString, isObject, RPC, RPCConnection, RPCError, type JsonObject, type JsonValue } from './jsonrpc'
import { AgentTranscript } from './transcript'

/* The ACP client side of one agent process: it starts the process, runs
   `initialize` and `session/new`, sends prompts, and answers the agent's
   requests. Inkwell advertises fs.readTextFile and fs.writeTextFile only;
   never `terminal`. Port of InkwellMac ACPClient.swift. */

export const PROTOCOL_VERSION = 1

export type PermissionOption = { optionId: string; name: string; kind: string }

/** The option to use when the user closes the sheet without choosing: a
    reject, never an allow. Undefined means answer `cancelled`. */
export const safestOption = (options: PermissionOption[]): PermissionOption | undefined =>
  options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always')

/** What the client needs from the app: tool permission sheets. File access
    goes through AgentFileAccess. */
export type ClientHost = {
  /** The chosen optionId, or null for `cancelled`. */
  requestPermission: (request: { title: string; detail: string; options: PermissionOption[] }) => Promise<string | null>
  /** The turn was cancelled: close any open permission sheet (it answers null). */
  dismissPermissionRequests: () => void
  /** Changed transcript entries, batched. */
  onEntries: (entries: AgentTranscriptEntry[]) => void
  onState: (state: AgentSessionState) => void
}

/** The open note, sent with the first prompt of a session. */
export type NoteContext = {
  name: string
  path?: string
  content: string
  /** A draft with no file yet: `path` is where Inkwell lets the agent read and
      write it through fs/*, and nothing is on disk there. */
  unsaved?: boolean
}

export type ClientOptions = {
  harness: AgentHarnessId
  title: string
  launch: ProcessSpec
  files: AgentFileAccess
  host: ClientHost
  clientVersion?: string
  /** Delay before a burst of chunks is flushed to the renderer. */
  flushMs?: number
}

export type ClientState = 'starting' | 'ready' | 'prompting' | 'failed' | 'stopped'

export class ACPClient {
  readonly transcript = new AgentTranscript()
  state: ClientState = 'starting'
  failure = ''
  agentTitle?: string
  sessionId?: string
  hasPrompted = false

  private process: AgentProcess | null = null
  private connection: RPCConnection | null = null
  private embeddedContext = false
  private cancelGeneration = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: ClientOptions) {}

  get title(): string {
    return this.options.title
  }

  /** The folder the session was opened in. */
  get cwd(): string {
    return this.options.launch.cwd
  }

  get harness(): AgentHarnessId {
    return this.options.harness
  }

  get isBusy(): boolean {
    return this.state === 'prompting'
  }

  get isRunning(): boolean {
    return this.state === 'ready' || this.state === 'prompting' || this.state === 'starting'
  }

  sessionState(): AgentSessionState {
    const harness = this.options.harness
    switch (this.state) {
      case 'starting': return { state: 'starting', harness }
      case 'ready': return { state: 'ready', harness, agentTitle: this.agentTitle }
      case 'prompting': return { state: 'prompting', harness, agentTitle: this.agentTitle }
      case 'failed': return { state: 'failed', message: this.failure }
      case 'stopped': return { state: 'stopped' }
    }
  }

  /** Launches the agent and opens a session. On failure `state` is 'failed'
      with a message for the user. */
  async start(): Promise<void> {
    const { title, launch } = this.options
    const process = new AgentProcess(launch)
    const connection = new RPCConnection((line) => process.write(line))
    connection.notificationHandler = (method, params) => this.handleNotification(method, params)
    connection.requestHandler = (method, params) => this.handleRequest(method, params)
    this.process = process
    this.connection = connection
    this.transcript.addStatus(`Starting ${title}…`)
    this.publish()
    try {
      process.start((data) => connection.receive(data), (status) => this.processExited(status))
    } catch (error) {
      this.fail(`Could not start ${title}: ${describe(error)}`)
      return
    }

    try {
      const result = await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'inkwell', title: 'Inkwell', version: this.options.clientVersion ?? 'dev' }
      })
      const info = isObject(result) ? result : {}
      if (info.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(`${title} speaks ACP version ${asInt(info.protocolVersion) ?? '?'}, Inkwell speaks ${PROTOCOL_VERSION}`)
        return
      }
      const capabilities = isObject(info.agentCapabilities) ? info.agentCapabilities : {}
      const prompting = isObject(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {}
      this.embeddedContext = prompting.embeddedContext === true
      const agentInfo = isObject(info.agentInfo) ? info.agentInfo : {}
      this.agentTitle = asString(agentInfo.title) ?? asString(agentInfo.name)
    } catch (error) {
      this.fail(`${title} did not finish starting: ${describe(error)}`)
      return
    }
    if (this.state !== 'starting') return

    try {
      const result = await connection.request('session/new', { cwd: launch.cwd, mcpServers: [] })
      const id = isObject(result) ? asString(result.sessionId) : undefined
      if (!id) {
        this.fail(`${title} did not open a session`)
        return
      }
      if (this.state !== 'starting') return
      this.sessionId = id
      this.state = 'ready'
      this.transcript.addStatus(`Connected to ${title}`)
      this.publish()
    } catch (error) {
      if (error instanceof RPCError && error.code === -32000) {
        this.fail(`${title} needs you to sign in. Run it once in a terminal to log in, then start a new session.`)
      } else {
        this.fail(`${title} could not open a session: ${describe(error)}`)
      }
    }
  }

  /** Sends one prompt turn. With `note`, the note goes along as a resource
      (embedded when the agent supports it, else a link plus its text). */
  async prompt(text: string, note?: NoteContext): Promise<void> {
    const connection = this.connection
    const sessionId = this.sessionId
    if (this.state !== 'ready' || !connection || !sessionId) return
    const blocks: JsonValue[] = [{ type: 'text', text }]
    if (note) blocks.push(...this.noteBlocks(note))
    this.hasPrompted = true
    this.transcript.addUser(note ? `${text}\n\nAttached: ${note.name}` : text)
    this.state = 'prompting'
    this.publish()
    try {
      const result = await connection.request('session/prompt', { sessionId, prompt: blocks })
      const reason = (isObject(result) ? asString(result.stopReason) : undefined) ?? 'end_turn'
      switch (reason) {
        case 'end_turn': break
        case 'cancelled': this.transcript.addStatus('Cancelled'); break
        case 'max_tokens': this.transcript.addStatus('Stopped: the reply hit its length limit'); break
        case 'max_turn_requests': this.transcript.addStatus('Stopped: too many steps in one turn'); break
        case 'refusal': this.transcript.addStatus('The agent declined to continue'); break
        default: this.transcript.addStatus(`Stopped: ${reason}`)
      }
      if (this.state === 'prompting') this.state = 'ready'
    } catch (error) {
      if (this.state === 'prompting') {
        this.transcript.addError(describe(error))
        this.state = 'ready'
      }
    }
    this.publish()
  }

  noteBlocks(note: NoteContext): JsonValue[] {
    const uri = note.path ? pathToFileURL(note.path).href : `inkwell:untitled/${encodeURIComponent(note.name)}`
    const hint: JsonValue[] = note.unsaved
      ? [{
          type: 'text',
          text: `${note.name} is open in Inkwell but not saved to disk yet. To change it, write the whole note to ${note.path ?? ''} with the client file tools (fs/write_text_file); shell commands will not find it.`
        }]
      : []
    if (this.embeddedContext) {
      return [{ type: 'resource', resource: { uri, mimeType: 'text/markdown', text: note.content } }, ...hint]
    }
    // Baseline agents only promise text and resource_link.
    return [
      { type: 'resource_link', uri, name: note.name, mimeType: 'text/markdown' },
      { type: 'text', text: `Contents of ${note.name}:\n\n${note.content}` },
      ...hint
    ]
  }

  /** `session/cancel`: open tool calls show as cancelled and open permission
      sheets answer `cancelled`. */
  cancel(): void {
    if (this.state !== 'prompting' || !this.sessionId) return
    this.cancelGeneration += 1
    this.connection?.notify('session/cancel', { sessionId: this.sessionId })
    this.transcript.markOpenToolsCancelled()
    this.options.host.dismissPermissionRequests()
    this.publish()
  }

  /** Cancels, closes stdin, then terminates and kills on a timeout. */
  async stop(): Promise<void> {
    const process = this.shutDown()
    if (process) await process.stopAndWait()
  }

  /** Kills the process tree now, without waiting. For quit and window close. */
  forceKill(): void {
    const process = this.shutDown()
    process?.kill(true)
  }

  private shutDown(): AgentProcess | null {
    const process = this.process
    if (!process) return null
    if (this.state === 'prompting') this.cancel()
    if (this.state !== 'stopped' && this.state !== 'failed') this.transcript.addStatus('Stopped')
    this.state = 'stopped'
    this.connection?.close()
    this.process = null
    this.publish()
    return process
  }

  private fail(message: string): void {
    if (this.state === 'stopped' || this.state === 'failed') return
    this.state = 'failed'
    this.failure = message
    this.transcript.addError(message)
    this.connection?.close(new RPCError(RPC.connectionClosed, message))
    const process = this.process
    this.process = null
    this.publish()
    if (process) void process.stopAndWait()
  }

  private processExited(status: number): void {
    if (this.state === 'stopped' || this.state === 'failed') return
    const tail = (this.process?.errorTail ?? '').trim().split('\n').pop() ?? ''
    this.process = null
    this.fail(`${this.options.title} exited (status ${status})${tail ? `: ${tail.slice(0, 300)}` : ''}`)
  }

  /** Pushes changed entries and the state to the app right now. */
  private publish(): void {
    this.flushEntries()
    this.options.host.onState(this.sessionState())
  }

  /** Streaming chunks are batched, so a reply is not one IPC message per word. */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flushEntries(), this.options.flushMs ?? 40)
  }

  private flushEntries(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const changed = this.transcript.drainChanged()
    if (changed.length) this.options.host.onEntries(changed)
  }

  // Agent -> client

  private handleNotification(method: string, params: JsonValue | undefined): void {
    if (method !== 'session/update' || !isObject(params) || params.sessionId !== this.sessionId) return
    this.transcript.apply(params.update)
    this.scheduleFlush()
  }

  private async handleRequest(method: string, params: JsonValue | undefined): Promise<JsonValue> {
    if (!isObject(params) || this.sessionId === undefined || params.sessionId !== this.sessionId) {
      throw new RPCError(RPC.invalidParams, 'Unknown session', { sessionId: isObject(params) ? params.sessionId ?? null : null })
    }
    switch (method) {
      case 'session/request_permission':
        return this.permission(params)
      case 'fs/read_text_file': {
        const path = asString(params.path)
        if (path === undefined) throw new RPCError(RPC.invalidParams, 'path is required')
        try {
          return { content: await this.options.files.read(path, asInt(params.line), asInt(params.limit)) }
        } catch (error) {
          // A missing file is routine (harnesses read before creating).
          if (error instanceof RPCError && error.code !== RPC.resourceNotFound) this.noteRefusal(error, 'read', path)
          throw error
        }
      }
      case 'fs/write_text_file': {
        const path = asString(params.path)
        const content = asString(params.content)
        if (path === undefined || content === undefined) throw new RPCError(RPC.invalidParams, 'path and content are required')
        try {
          await this.options.files.write(path, content)
        } catch (error) {
          if (error instanceof RPCError) this.noteRefusal(error, 'write', path)
          throw error
        }
        return {}
      }
      default:
        // terminal/* and anything else Inkwell did not advertise.
        throw new RPCError(RPC.methodNotFound, 'Method not found')
    }
  }

  /** Says in the panel who stopped a file request and why. */
  private noteRefusal(error: RPCError, verb: 'read' | 'write', path: string): void {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    const refusedBy = isObject(error.data) ? asString(error.data.refusedBy) : undefined
    if (refusedBy === 'user') {
      this.transcript.markRefused(undefined, 'you', `You denied this ${verb} in Inkwell`)
      this.transcript.addStatus(`You denied the ${verb} to ${name}`)
    } else if (refusedBy === 'inkwell') {
      this.transcript.markRefused(undefined, 'Inkwell', error.message)
      this.transcript.addError(`Inkwell blocked the ${verb} to ${path}: ${error.message}`)
    } else {
      this.transcript.addError(`Inkwell could not ${verb} ${path}: ${error.message}`)
    }
    this.scheduleFlush()
  }

  /** A line from Inkwell itself in the panel, such as why nothing is shared. */
  addNotice(text: string): void {
    this.transcript.addStatus(text)
    this.publish()
  }

  private async permission(params: JsonObject): Promise<JsonValue> {
    const cancelled: JsonValue = { outcome: { outcome: 'cancelled' } }
    const options: PermissionOption[] = []
    for (const option of Array.isArray(params.options) ? params.options : []) {
      if (!isObject(option)) continue
      const optionId = asString(option.optionId)
      if (optionId === undefined) continue
      options.push({ optionId, name: asString(option.name) ?? optionId, kind: asString(option.kind) ?? '' })
    }
    if (options.length === 0 || this.state !== 'prompting') return cancelled
    const generation = this.cancelGeneration
    const toolCall = isObject(params.toolCall) ? params.toolCall : undefined
    const toolCallId = toolCall ? asString(toolCall.toolCallId) : undefined
    const known = this.transcript.toolCall(toolCallId)
    const title = (toolCall ? asString(toolCall.title) : undefined) ?? known?.title ?? 'The agent wants to run a tool'
    const detail: string[] = []
    const kind = (toolCall ? asString(toolCall.kind) : undefined) ?? known?.kind
    if (kind) detail.push(`Kind: ${kind}`)
    const paths: string[] = []
    for (const location of Array.isArray(toolCall?.locations) ? toolCall.locations : []) {
      const path = isObject(location) ? asString(location.path) : undefined
      if (path) paths.push(path)
    }
    for (const item of Array.isArray(toolCall?.content) ? toolCall.content : []) {
      const path = isObject(item) ? asString(item.path) : undefined
      if (path) paths.push(path)
    }
    for (const path of (paths.length ? paths : known?.paths ?? []).slice(0, 20)) detail.push(`Path: ${path}`)
    if (toolCall && toolCall.rawInput !== undefined && toolCall.rawInput !== null) {
      detail.push('Input: ' + JSON.stringify(toolCall.rawInput).slice(0, 2000))
    }
    const chosen = await this.options.host.requestPermission({ title, detail: detail.join('\n'), options })
    // A cancel while the sheet was up wins over whatever was clicked.
    const option = options.find((entry) => entry.optionId === chosen)
    if (generation !== this.cancelGeneration || chosen === null || !option) return cancelled
    if (option.kind.startsWith('reject')) {
      this.transcript.markRefused(toolCallId, 'you', `You chose “${option.name}”`)
      this.scheduleFlush()
    }
    return { outcome: { outcome: 'selected', optionId: chosen } }
  }
}

function describe(error: unknown): string {
  if (error instanceof RPCError) return error.message
  return error instanceof Error ? error.message : String(error)
}
