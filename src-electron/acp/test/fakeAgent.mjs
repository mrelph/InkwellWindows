#!/usr/bin/env node
/* A fake ACP agent for Inkwell's tests. Stdio only. Port of
   InkwellMac Tests/FakeAgent/fake_acp_agent.py.

   It answers initialize and session/new, then for each session/prompt:
   streams a plan, a thought and a reply, reports a tool call, asks permission,
   reads the target file and asks to write it. Modes (first argument):
     (none)   the full flow above
     --demo   (or FAKE_ACP_DEMO=1) stream only (no permission, no file access)
     --exit-early   print to stderr and exit with status 3 before initialize
   Prompt text "wait for cancel" makes it wait for session/cancel.
   Every message it receives is appended to $FAKE_ACP_LOG when set.
   With FAKE_ACP_CREATE=1 it writes a new file without reading it first.
   The file it edits is $FAKE_ACP_TARGET, else the prompt's resource, else
   <cwd>/note.md. */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import nodePath from 'node:path'
import readline from 'node:readline'

const argument = process.argv[2]
const DEMO = argument === '--demo' || process.env.FAKE_ACP_DEMO === '1'
const LOG = process.env.FAKE_ACP_LOG
const cwd = process.cwd()
let nextId = 100
let cancelled = false

if (argument === '--exit-early') {
  process.stderr.write('no login\n')
  process.exit(3)
}

const log = (message) => { if (LOG) appendFileSync(LOG, JSON.stringify(message) + '\n') }
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const sendRaw = (text) => process.stdout.write(text)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()

async function readMessage() {
  for (;;) {
    const { value, done } = await lines.next()
    if (done) process.exit(0)
    if (!value.trim()) continue
    const message = JSON.parse(value)
    log(message)
    return message
  }
}

/** Messages that may arrive while we wait for something else. */
function handleSide(message) {
  if (message.method === 'session/cancel') cancelled = true
}

/** Sends a request to the client and waits for its response. */
async function call(method, params) {
  const id = ++nextId
  send({ jsonrpc: '2.0', id, method, params })
  for (;;) {
    const message = await readMessage()
    if (message.id === id && !('method' in message)) return message
    handleSide(message)
  }
}

const update = (session, body) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: body } })

const chunk = (kind, text, messageId) => ({ sessionUpdate: kind, messageId, content: { type: 'text', text } })

async function runPrompt(request) {
  cancelled = false
  const { sessionId: session, prompt: blocks = [] } = request.params
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ')
  let target = process.env.FAKE_ACP_TARGET
  for (const block of blocks) {
    const uri = block.resource?.uri ?? block.uri
    if (!target && uri && uri.startsWith('file://')) target = fileURLToPath(uri)
  }
  target = target || nodePath.join(cwd, 'note.md')

  if (text.includes('wait for cancel')) {
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'call_wait', title: 'Thinking hard', kind: 'think', status: 'in_progress' })
    await call('session/request_permission', {
      sessionId: session,
      toolCall: { toolCallId: 'call_wait' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    while (!cancelled) handleSide(await readMessage())
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' } })
    return
  }

  update(session, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Read the note', priority: 'high', status: 'completed' },
      { content: 'Suggest a tighter opening', priority: 'medium', status: 'in_progress' },
      { content: 'Append a summary line', priority: 'low', status: 'pending' }
    ]
  })
  update(session, chunk('agent_thought_chunk', 'The note opens slowly. A one-line summary would help.', 't1'))
  // Two messages in one write, then one message split across two writes: the
  // client's framing must handle both.
  const wrap = (body) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: body } })
  sendRaw(wrap(chunk('agent_message_chunk', 'Here is what I found in **your note**:\n\n', 'm1')) + '\n'
    + wrap(chunk('agent_message_chunk', '- The opening runs long\n', 'm1')) + '\n')
  const third = wrap(chunk('agent_message_chunk', '- A summary line would help\n\nI can add one at the end.', 'm1'))
  sendRaw(third.slice(0, 25))
  await sleep(50)
  sendRaw(third.slice(25) + '\n')

  if (DEMO) {
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Read note.md', kind: 'read', status: 'completed', locations: [{ path: target }] })
    update(session, { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Append a summary line', kind: 'edit', status: 'in_progress', locations: [{ path: target }] })
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    return
  }

  update(session, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Append a summary line', kind: 'edit', status: 'pending', locations: [{ path: target }] })
  const answer = await call('session/request_permission', {
    sessionId: session,
    toolCall: { toolCallId: 'call_1', title: 'Append a summary line', kind: 'edit', locations: [{ path: target }] },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ]
  })
  const outcome = answer.result?.outcome ?? {}
  if (outcome.outcome !== 'selected' || outcome.optionId !== 'allow') {
    update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' })
    update(session, chunk('agent_message_chunk', '\n\nOK, I left it alone.', 'm2'))
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    return
  }

  update(session, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' })
  // FAKE_ACP_CREATE=1: a new note, written without reading it first.
  const read = process.env.FAKE_ACP_CREATE === '1'
    ? { result: { content: '' } }
    : await call('fs/read_text_file', { sessionId: session, path: target })
  const old = read.result?.content
  if (old === undefined || old === null) {
    update(session, {
      sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'read failed' } }]
    })
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    return
  }
  const next = old + '\nSummary: added by the fake agent.\n'
  const wrote = await call('fs/write_text_file', { sessionId: session, path: target, content: next })
  const status = 'result' in wrote ? 'completed' : 'failed'
  update(session, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status,
    content: [{ type: 'diff', path: target, oldText: old, newText: next }]
  })
  update(session, chunk('agent_message_chunk', status === 'completed' ? '\n\nDone.' : '\n\nThe write was refused.', 'm2'))
  send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
}

for (;;) {
  const message = await readMessage()
  const { method } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
        agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '1.0' },
        authMethods: []
      }
    })
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess_fake' } })
  } else if (method === 'session/prompt') {
    await runPrompt(message)
  } else if (message.id !== undefined && method) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}
