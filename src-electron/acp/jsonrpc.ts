/* JSON-RPC 2.0 over newline-delimited JSON — ACP's stdio framing. A port of
   InkwellMac RPCConnection.swift and LineFramer.swift. Pure: bytes come in
   through `receive`, go out through the `send` callback. No Electron, no I/O. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
export const asInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  resourceNotFound: -32002,
  /** The connection closed before an answer came. */
  connectionClosed: -32099
} as const

/** A JSON-RPC 2.0 error object, thrown and returned. */
export class RPCError extends Error {
  constructor(readonly code: number, message: string, readonly data?: JsonValue) {
    super(message)
    this.name = 'RPCError'
  }

  toJSON(): JsonObject {
    const object: JsonObject = { code: this.code, message: this.message }
    if (this.data !== undefined) object.data = this.data
    return object
  }
}

/** A single message larger than this ends the connection instead of growing
    memory without bound. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024

export class LineTooLongError extends Error {
  constructor() {
    super('A message from the agent is too large')
    this.name = 'LineTooLongError'
  }
}

/** Splits a byte stream into newline-delimited messages. Reads can end
    mid-line or hold several lines; both work. Chunks are kept in a list and
    joined only when their newline arrives, so a huge line arriving in many
    reads is not recopied each time. */
export class LineFramer {
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  /** Bytes waiting for their newline. */
  get pending(): number {
    return this.size
  }

  /** Feeds bytes in and returns every complete line, without its `\n` (and a
      trailing `\r`). Blank lines are dropped. Throws LineTooLongError when a
      single line grows past the limit. */
  append(data: Buffer | string): Buffer[] {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const lines: Buffer[] = []
    let start = 0
    for (;;) {
      const newline = input.indexOf(0x0a, start)
      if (newline === -1) break
      const tail = input.subarray(start, newline)
      let line = this.chunks.length ? Buffer.concat([...this.chunks, tail]) : tail
      this.chunks = []
      this.size = 0
      if (line.length > this.maxLineBytes) throw new LineTooLongError()
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length) lines.push(Buffer.from(line))
      start = newline + 1
    }
    if (start < input.length) {
      const rest = input.subarray(start)
      this.chunks.push(Buffer.from(rest))
      this.size += rest.length
      if (this.size > this.maxLineBytes) throw new LineTooLongError()
    }
    return lines
  }
}

export type RequestHandler = (method: string, params: JsonValue | undefined) => Promise<JsonValue>
export type NotificationHandler = (method: string, params: JsonValue | undefined) => void

/** Sends requests and matches their responses by id, and answers the peer's
    requests through `requestHandler`. Requests from the peer run
    concurrently, so a slow one (a permission sheet) never blocks reading. */
export class RPCConnection {
  requestHandler?: RequestHandler
  notificationHandler?: NotificationHandler
  /** Malformed input from the peer, for display or logging. */
  onProtocolError?: (message: string) => void

  private framer: LineFramer
  private nextId = 0
  private pending = new Map<number, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>()
  private closed = false

  constructor(private readonly send: (line: string) => void, maxLineBytes = MAX_LINE_BYTES) {
    this.framer = new LineFramer(maxLineBytes)
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pendingRequestCount(): number {
    return this.pending.size
  }

  /** Sends a request and waits for its result. Rejects with RPCError for an
      error response or a closed connection. */
  request(method: string, params: JsonValue = {}): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new RPCError(RPC.connectionClosed, 'The agent is not running'))
    const id = this.nextId++
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: JsonValue = {}): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Bytes from the peer. Any number of messages, or part of one. */
  receive(data: Buffer | string): void {
    if (this.closed) return
    let lines: Buffer[]
    try {
      lines = this.framer.append(data)
    } catch {
      this.close(new RPCError(RPC.parseError, 'The agent sent a message that is too large'))
      return
    }
    for (const line of lines) {
      if (this.closed) return
      this.handle(line)
    }
  }

  /** Fails every waiting request. Later sends are dropped. */
  close(reason: RPCError = new RPCError(RPC.connectionClosed, 'The agent stopped')): void {
    if (this.closed) return
    this.closed = true
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const entry of waiting) entry.reject(reason)
  }

  private write(message: JsonObject): void {
    this.send(JSON.stringify(message) + '\n')
  }

  private handle(line: Buffer): void {
    let message: unknown
    try {
      message = JSON.parse(line.toString('utf8'))
    } catch {
      message = undefined
    }
    if (!isObject(message)) {
      this.onProtocolError?.('Unreadable message from the agent')
      this.write({ jsonrpc: '2.0', id: null, error: new RPCError(RPC.parseError, 'Parse error').toJSON() })
      return
    }
    const id = message.id
    const method = asString(message.method)
    if (method !== undefined) {
      if (typeof id === 'string' || typeof id === 'number') this.answer(id, method, message.params)
      else this.notificationHandler?.(method, message.params)
      return
    }
    // A response: match it to the request that is waiting for it.
    const waiting = typeof id === 'number' ? this.pending.get(id) : undefined
    if (typeof id !== 'number' || !waiting) {
      this.onProtocolError?.('A response for an unknown request')
      return
    }
    this.pending.delete(id)
    if (isObject(message.error)) {
      waiting.reject(new RPCError(
        asInt(message.error.code) ?? RPC.internalError,
        asString(message.error.message) ?? 'Unknown error',
        message.error.data
      ))
    } else {
      waiting.resolve(message.result ?? null)
    }
  }

  private answer(id: string | number, method: string, params: JsonValue | undefined): void {
    const handler = this.requestHandler
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: new RPCError(RPC.methodNotFound, 'Method not found').toJSON() })
      return
    }
    void (async () => {
      let response: JsonObject
      try {
        const result = await handler(method, params)
        response = { jsonrpc: '2.0', id, result }
      } catch (error) {
        const rpc = error instanceof RPCError ? error : new RPCError(RPC.internalError, 'Internal error')
        response = { jsonrpc: '2.0', id, error: rpc.toJSON() }
      }
      if (!this.closed) this.write(response)
    })()
  }
}
