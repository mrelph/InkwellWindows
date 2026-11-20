import { describe, expect, it } from 'vitest'
import { LineFramer, LineTooLongError, MAX_LINE_BYTES, RPC, RPCConnection, RPCError, type JsonValue } from './jsonrpc'

const text = (buffers: Buffer[]) => buffers.map((buffer) => buffer.toString('utf8'))
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('LineFramer', () => {
  it('holds a partial line until its newline arrives', () => {
    const framer = new LineFramer()
    expect(framer.append('{"a":')).toEqual([])
    expect(framer.pending).toBe(5)
    expect(text(framer.append('1}\n{"b"'))).toEqual(['{"a":1}'])
    expect(text(framer.append(':2}\n'))).toEqual(['{"b":2}'])
    expect(framer.pending).toBe(0)
  })

  it('splits several messages in one read, drops blank lines and strips CR', () => {
    const framer = new LineFramer()
    const lines = framer.append('{"a":1}\n\n{"b":2}\r\n{"c":3}\n{"d"')
    expect(text(lines)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(framer.pending).toBe(4)
  })

  it('does not split a multibyte character across reads', () => {
    const framer = new LineFramer()
    const bytes = Buffer.from('{"t":"é—日本"}\n', 'utf8')
    const lines = [...framer.append(bytes.subarray(0, 8)), ...framer.append(bytes.subarray(8))]
    expect(text(lines)).toEqual(['{"t":"é—日本"}'])
  })

  it('fails on a line past the limit instead of growing without bound', () => {
    const framer = new LineFramer(16)
    expect(() => framer.append(Buffer.alloc(17, 0x61))).toThrow(LineTooLongError)
    expect(MAX_LINE_BYTES).toBe(32 * 1024 * 1024)
  })

  it('fails on a long line that arrives in pieces', () => {
    const framer = new LineFramer(16)
    framer.append(Buffer.alloc(10, 0x61))
    expect(() => framer.append(Buffer.alloc(10, 0x61))).toThrow(LineTooLongError)
  })

  it('encoded messages never contain a raw newline', () => {
    const line = JSON.stringify({ text: 'two\nlines', n: 3, ok: true, none: null })
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line).text).toBe('two\nlines')
  })
})

function connection() {
  const sent: Record<string, JsonValue>[] = []
  const rpc = new RPCConnection((line) => {
    for (const part of line.split('\n').filter(Boolean)) sent.push(JSON.parse(part))
  })
  return { rpc, sent }
}

describe('RPCConnection', () => {
  it('matches responses to their requests by id, in any order', async () => {
    const { rpc, sent } = connection()
    const first = rpc.request('first', { n: 1 })
    const second = rpc.request('second', { n: 2 })
    expect(sent).toHaveLength(2)
    const ids = Object.fromEntries(sent.map((message) => [message.method as string, message.id as number]))
    rpc.receive(`{"jsonrpc":"2.0","id":${ids.second},"result":"two"}\n{"jsonrpc":"2.0","id":${ids.first},"result":"one"}\n`)
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    expect(rpc.pendingRequestCount).toBe(0)
  })

  it('rejects with an RPCError for an error response', async () => {
    const { rpc, sent } = connection()
    const promise = rpc.request('boom')
    rpc.receive(`{"jsonrpc":"2.0","id":${sent[0].id},"error":{"code":-32002,"message":"nope","data":{"x":1}}}\n`)
    await expect(promise).rejects.toMatchObject({ code: -32002, message: 'nope', data: { x: 1 } })
  })

  it('reports a response for an unknown id and carries on', () => {
    const { rpc } = connection()
    const errors: string[] = []
    rpc.onProtocolError = (message) => errors.push(message)
    rpc.receive('{"jsonrpc":"2.0","id":999,"result":{}}\n')
    expect(errors).toHaveLength(1)
  })

  it('answers the peer\'s requests with their own id, string or number', async () => {
    const { rpc, sent } = connection()
    rpc.requestHandler = async (method, params) => {
      if (method === 'echo') return params ?? null
      throw new RPCError(RPC.methodNotFound, 'Method not found')
    }
    rpc.receive('{"jsonrpc":"2.0","id":"abc","method":"echo","params":{"x":1}}\n')
    rpc.receive('{"jsonrpc":"2.0","id":7,"method":"terminal/create","params":{}}\n')
    await settle()
    expect(sent.find((message) => message.id === 'abc')?.result).toEqual({ x: 1 })
    const missing = sent.find((message) => message.id === 7)
    expect((missing?.error as { code: number }).code).toBe(RPC.methodNotFound)
  })

  it('turns an unexpected handler failure into an internal error without its detail', async () => {
    const { rpc, sent } = connection()
    rpc.requestHandler = async () => { throw new Error('secret path C:\\Users\\x') }
    rpc.receive('{"jsonrpc":"2.0","id":1,"method":"x"}\n')
    await settle()
    expect(sent[0].error).toEqual({ code: RPC.internalError, message: 'Internal error' })
  })

  it('answers a request with method-not-found when there is no handler', () => {
    const { rpc, sent } = connection()
    rpc.receive('{"jsonrpc":"2.0","id":3,"method":"fs/read_text_file"}\n')
    expect((sent[0].error as { code: number }).code).toBe(RPC.methodNotFound)
  })

  it('delivers notifications in order even when a message is split across reads', () => {
    const { rpc } = connection()
    const seen: number[] = []
    rpc.notificationHandler = (_method, params) => seen.push((params as { n: number }).n)
    rpc.receive('{"jsonrpc":"2.0","method":"u","params":{"n":1}}\n{"jsonrpc":"2.0","method":"u","par')
    rpc.receive('ams":{"n":2}}\n')
    expect(seen).toEqual([1, 2])
  })

  it('gets a parse error for bad JSON and for a batch array', () => {
    const { rpc, sent } = connection()
    rpc.receive('not json\n[1,2]\n')
    expect(sent.map((message) => (message.error as { code: number }).code)).toEqual([RPC.parseError, RPC.parseError])
  })

  it('closing fails waiting requests and later requests', async () => {
    const { rpc } = connection()
    const waiting = rpc.request('never')
    rpc.close()
    await expect(waiting).rejects.toBeInstanceOf(RPCError)
    await expect(rpc.request('after')).rejects.toBeInstanceOf(RPCError)
  })

  it('closes when a message is too large', async () => {
    const sent: string[] = []
    const rpc = new RPCConnection((line) => sent.push(line), 8)
    const waiting = rpc.request('x')
    rpc.receive('0123456789')
    await expect(waiting).rejects.toMatchObject({ code: RPC.parseError })
    expect(rpc.isClosed).toBe(true)
  })
})
