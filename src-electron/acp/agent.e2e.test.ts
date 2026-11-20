import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentTranscriptEntry } from '../ipc/contract'
import { AgentController, type AgentEnvironment, type BufferAnswer, type BufferQuery, type PermissionPrompt } from './controller'
import { buildSpawn, harnessDefinition } from './harness'
import { canonical } from './pathSandbox'

const fakeAgent = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'test', 'fakeAgent.mjs')
const base = mkdtempSync(nodePath.join(os.tmpdir(), 'inkwell-e2e-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
const folder = () => {
  const dir = nodePath.join(base, `case${counter++}`)
  mkdirSync(dir, { recursive: true })
  return canonical(dir) as string
}

type Harness = ReturnType<typeof setup>

function setup(options: {
  root: string
  enabled?: boolean
  log?: string
  target?: string
  args?: string[]
  answer?: (prompt: PermissionPrompt) => string | null | Promise<string | null>
  buffers?: Map<string, string>
  /** Extra environment for the fake agent (FAKE_ACP_CREATE=1). */
  agentEnv?: Record<string, string>
  /** The notes-folder dialog's answer; it may add a folder to the context. */
  askNotesFolder?: (message: string) => boolean | Promise<boolean>
}) {
  const events: AgentEvent[] = []
  const prompts: PermissionPrompt[] = []
  const bufferQueries: BufferQuery[] = []
  const written: { path: string; created: boolean }[] = []
  const offers: string[] = []
  const buffers = options.buffers ?? new Map<string, string>()
  const env: AgentEnvironment = {
    isEnabled: () => options.enabled ?? true,
    getHarness: () => 'kiro',
    emit: (event) => events.push(event),
    askPermission: async (prompt) => {
      prompts.push(prompt)
      const answer = options.answer ?? ((p) => p.options.find((o) => o.kind === 'allow_once')?.optionId ?? null)
      return answer(prompt)
    },
    askBuffer: async (query): Promise<BufferAnswer> => {
      bufferQueries.push(query)
      const key = canonical(query.path) ?? query.path
      if (!buffers.has(key)) return { open: false }
      if (query.op === 'read') return { open: true, content: buffers.get(key) as string }
      buffers.set(key, query.content)
      return { open: true, applied: true }
    },
    onFileWritten: (path, created) => written.push({ path, created }),
    ...(options.askNotesFolder ? { askNotesFolder: async (message: string) => { offers.push(message); return options.askNotesFolder!(message) } } : {}),
    fallbackDirectory: () => nodePath.join(base, 'fallback'),
    home: nodePath.join(base, 'no-such-home'),
    flushMs: 5,
    prepareLaunch: async (_harness, cwd) => {
      const environment: Record<string, string> = { ...(process.env as Record<string, string>) }
      if (options.log) environment.FAKE_ACP_LOG = options.log
      if (options.target) environment.FAKE_ACP_TARGET = options.target
      Object.assign(environment, options.agentEnv)
      return { command: process.execPath, args: [fakeAgent, ...(options.args ?? [])], cwd, env: environment, title: 'Fake' }
    }
  }
  const controller = new AgentController(env)
  controller.setContext({ roots: [options.root] })
  return { controller, events, prompts, bufferQueries, buffers, written, offers }
}

const entries = (h: Harness): AgentTranscriptEntry[] => h.controller.session?.transcript.entries.slice() ?? []
const logged = (path: string) =>
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('agent end to end, against the fake agent', () => {
  it('runs initialize, a session, a prompt with streamed updates, a tool permission and a write sheet', async () => {
    const root = folder()
    const log = nodePath.join(folder(), 'agent.log')
    writeFileSync(nodePath.join(root, 'note.md'), '# Note\n\nFirst line.')
    const h = setup({ root, log })
    expect(await h.controller.newSession()).toEqual({ ok: true })
    const client = h.controller.session!
    expect(client.state).toBe('ready')
    expect(client.agentTitle).toBe('Fake Agent')

    const note = { name: 'note.md', path: nodePath.join(root, 'note.md'), content: '# Note\n\nFirst line.', unsaved: false }
    expect(await h.controller.prompt({ text: 'Tidy this note', includeNote: true, note })).toEqual({ ok: true })
    expect(client.state).toBe('ready')

    // The tool permission, then Inkwell's own write sheet with a diff.
    expect(h.prompts.map((p) => p.kind)).toEqual(['tool', 'write'])
    expect(h.prompts[0].title).toBe('Append a summary line')
    const write = h.prompts[1]
    expect(write.path).toBe(nodePath.join(root, 'note.md'))
    expect(write.options.map((o) => o.name)).toEqual(['Deny', 'Allow Once'])
    expect(write.diff?.some((line) => line.op === 'add' && line.text === 'Summary: added by the fake agent.')).toBe(true)
    expect(readFileSync(nodePath.join(root, 'note.md'), 'utf8')).toBe('# Note\n\nFirst line.\nSummary: added by the fake agent.\n')
    // A write that landed on disk is announced (agent:file-written), so the library refreshes.
    expect(h.written).toHaveLength(1)
    expect(h.written[0]).toMatchObject({ created: false })
    expect(canonical(h.written[0].path)).toBe(canonical(nodePath.join(root, 'note.md')))

    const list = entries(h)
    const reply = list.filter((e) => e.kind === 'agentMarkdown').map((e) => e.text).join('')
    expect(reply).toContain('Here is what I found in **your note**')
    expect(reply).toContain('A summary line would help') // the line split across two writes arrived whole
    expect(reply).toContain('Done.')
    expect(list.some((e) => e.kind === 'thought')).toBe(true)
    expect(list.some((e) => e.kind === 'plan' && e.plan?.length === 3)).toBe(true)
    expect(list.find((e) => e.kind === 'toolCall')?.tool?.status).toBe('completed')

    // What reached the renderer: a reset first, then entries, then state changes.
    expect(h.events[0]).toEqual({ type: 'reset' })
    expect(h.events.filter((e) => e.type === 'entry').length).toBeGreaterThan(5)
    const states = h.events.filter((e) => e.type === 'state').map((e) => (e as { state: { state: string } }).state.state)
    expect(states).toEqual(expect.arrayContaining(['starting', 'ready', 'prompting']))
    expect(states[states.length - 1]).toBe('ready')

    const messages = logged(log)
    const initialize = messages.find((m) => m.method === 'initialize')!
    expect(initialize.params.protocolVersion).toBe(1)
    expect(initialize.params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: false })
    expect(messages.find((m) => m.method === 'session/new')!.params.cwd).toBe(root)
    const blocks = messages.find((m) => m.method === 'session/prompt')!.params.prompt
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('resource')
    expect(blocks[1].resource.text).toBe('# Note\n\nFirst line.')
    expect(readdirSync(root)).toEqual(['note.md'])

    await h.controller.stop()
    expect(client.state).toBe('stopped')
  })

  it('a denied tool permission writes nothing and marks the call as denied by the user', async () => {
    const root = folder()
    const target = nodePath.join(root, 'note.md')
    writeFileSync(target, 'keep')
    const h = setup({ root, target, answer: (p) => p.options.find((o) => o.kind === 'reject_once')?.optionId ?? null })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Edit it', includeNote: false })
    expect(readFileSync(target, 'utf8')).toBe('keep')
    const tool = entries(h).find((e) => e.kind === 'toolCall')!.tool!
    expect(tool.status).toBe('failed')
    expect(tool.refusedBy).toBe('you')
    expect(h.prompts.map((p) => p.kind)).toEqual(['tool'])
    await h.controller.stop()
  })

  it('a denied Allow Once sheet leaves the file alone and the transcript says so', async () => {
    const root = folder()
    const target = nodePath.join(root, 'note.md')
    writeFileSync(target, 'keep')
    const h = setup({ root, target, answer: (p) => (p.kind === 'write' ? 'deny' : 'allow') })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Edit it', includeNote: false })
    expect(readFileSync(target, 'utf8')).toBe('keep')
    const list = entries(h)
    expect(list.some((e) => e.kind === 'status' && e.text === 'You denied the write to note.md')).toBe(true)
    expect(list.find((e) => e.kind === 'toolCall')?.tool).toMatchObject({ status: 'failed', refusedBy: 'you' })
    await h.controller.stop()
  })

  it('a write outside the sandbox is refused by Inkwell without a sheet', async () => {
    const root = folder()
    const outside = folder()
    const target = nodePath.join(outside, 'x.md')
    writeFileSync(target, 'outside')
    const h = setup({ root, target })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Edit it', includeNote: false })
    expect(readFileSync(target, 'utf8')).toBe('outside')
    expect(h.prompts.map((p) => p.kind)).toEqual(['tool']) // never a write sheet
    const list = entries(h)
    expect(list.find((e) => e.kind === 'toolCall')?.tool).toMatchObject({ status: 'failed', refusedBy: 'Inkwell' })
    expect(list.some((e) => e.kind === 'error' && e.text.startsWith('Inkwell blocked the read'))).toBe(true)
    await h.controller.stop()
  })

  it('an open note is read from and written to its buffer as one edit, never the disk', async () => {
    const root = folder()
    const target = nodePath.join(root, 'open.md')
    writeFileSync(target, 'on disk')
    const buffers = new Map([[target, 'unsaved text']])
    const h = setup({ root, target, buffers })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Edit it', includeNote: false })
    expect(buffers.get(target)).toBe('unsaved text\nSummary: added by the fake agent.\n')
    expect(readFileSync(target, 'utf8')).toBe('on disk')
    expect(h.bufferQueries.filter((q) => q.op === 'write')).toHaveLength(1)
    const write = h.prompts.find((p) => p.kind === 'write')!
    expect(write.detail).toContain('open note')
    expect(write.diff?.some((line) => line.op === 'keep' && line.text === 'unsaved text')).toBe(true)
    await h.controller.stop()
  })

  it('an unsaved draft is offered at a stand-in path in the session folder and edited in its buffer', async () => {
    const root = folder()
    const draft = nodePath.join(root, 'Untitled note.md')
    const buffers = new Map([[draft, '# Untitled']])
    const h = setup({ root, buffers })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Fill it', includeNote: true, note: { name: 'Untitled note.md', content: '# Untitled', unsaved: true, docId: 'draft:3' } })
    expect(buffers.get(draft)).toContain('Summary: added by the fake agent.')
    expect(existsSync(draft)).toBe(false)
    // Every buffer round trip names the draft exactly, by its document id.
    expect(h.bufferQueries.length).toBeGreaterThan(0)
    for (const query of h.bufferQueries) expect(query).toMatchObject({ draft: true, docId: 'draft:3' })
    // A buffer edit is not a disk write.
    expect(h.written).toEqual([])
    await h.controller.stop()
  })

  it('cancel answers the open permission as cancelled and ends the turn', async () => {
    const root = folder()
    const log = nodePath.join(folder(), 'agent.log')
    let release: (value: string | null) => void = () => undefined
    const h = setup({ root, log, answer: () => new Promise<string | null>((resolve) => { release = resolve }) })
    await h.controller.newSession()
    const turn = h.controller.prompt({ text: 'wait for cancel', includeNote: false })
    for (let i = 0; i < 300 && h.prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(h.prompts).toHaveLength(1)
    expect(h.controller.session?.state).toBe('prompting')
    h.controller.cancel()
    release('allow') // the sheet was closed; whatever it said must not count
    await turn
    const client = h.controller.session!
    expect(client.state).toBe('ready')
    const list = entries(h)
    expect(list.some((e) => e.kind === 'status' && e.text === 'Cancelled')).toBe(true)
    expect(list.find((e) => e.kind === 'toolCall')?.tool?.status).toBe('cancelled')
    const messages = logged(log)
    expect(messages.some((m) => m.method === 'session/cancel' && m.params.sessionId === 'sess_fake')).toBe(true)
    expect(messages.some((m) => m.result?.outcome?.outcome === 'cancelled')).toBe(true)
    await h.controller.stop()
  })

  it('stop leaves no process behind', async () => {
    const root = folder()
    const h = setup({ root })
    await h.controller.newSession()
    const pid = (h.controller.session as unknown as { process: { pid: number } }).process.pid
    expect(alive(pid)).toBe(true)
    await h.controller.stop()
    expect(alive(pid)).toBe(false)
    expect(h.controller.state()).toEqual({ state: 'stopped' })
  })

  it('forceKill (quit) ends the process without waiting', async () => {
    const root = folder()
    const h = setup({ root })
    await h.controller.newSession()
    const pid = (h.controller.session as unknown as { process: { pid: number } }).process.pid
    h.controller.forceKill()
    for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25))
    expect(alive(pid)).toBe(false)
  })

  it('an agent that exits early is an error that carries its stderr', async () => {
    const root = folder()
    const h = setup({ root, args: ['--exit-early'] })
    const result = await h.controller.newSession()
    expect(result.ok).toBe(false)
    const state = h.controller.state()
    expect(state.state).toBe('failed')
    expect((state as { message: string }).message).toContain('Fake exited (status 3): no login')
  })

  it('a program that cannot start is reported, not thrown', async () => {
    const root = folder()
    const h = setup({ root })
    // Override the launch with a path that does not exist.
    const env = (h.controller as unknown as { env: AgentEnvironment }).env
    env.prepareLaunch = async (_harness, cwd) => ({ command: nodePath.join(base, 'nope.exe'), args: [], cwd, env: {}, title: 'Ghost' })
    const result = await h.controller.newSession()
    expect(result.ok).toBe(false)
    expect(h.controller.state().state).toBe('failed')
  })

  it('a harness that is not installed says so, and a disabled agent launches nothing', async () => {
    const root = folder()
    const h = setup({ root })
    const env = (h.controller as unknown as { env: AgentEnvironment }).env
    env.prepareLaunch = async () => null
    expect(await h.controller.newSession()).toEqual({ ok: false, message: `${harnessDefinition('kiro').title} is not installed` })

    let launches = 0
    const off = setup({ root, enabled: false })
    const offEnv = (off.controller as unknown as { env: AgentEnvironment }).env
    const prepare = offEnv.prepareLaunch!
    offEnv.prepareLaunch = async (...args) => { launches++; return prepare(...args) }
    expect((await off.controller.newSession()).ok).toBe(false)
    expect((await off.controller.prompt({ text: 'hi', includeNote: false })).ok).toBe(false)
    expect((await off.controller.listHarnesses()).every((entry) => !entry.installed)).toBe(true)
    // The persisted choice is exposed, so the panel needs no storage of its own.
    expect((await off.controller.listHarnesses()).filter((entry) => entry.selected).map((entry) => entry.id)).toEqual(['kiro'])
    expect(launches).toBe(0)
    expect(off.controller.state()).toEqual({ state: 'disabled' })
  })

  it('says so when no folder is shared, and mentions the open unsaved note when there is one', async () => {
    const h = setup({ root: folder() })
    h.controller.setContext({ roots: [] })
    await h.controller.newSession()
    const notice = entries(h).find((e) => e.kind === 'status' && e.text.startsWith('No notes folder is shared yet'))
    expect(notice?.text).toContain('Integrations ▸ Agent ▸ Add Notes Folder…')
    expect(notice?.text).not.toContain('unsaved')
    await h.controller.stop()

    const draft = setup({ root: folder() })
    draft.controller.setContext({ roots: [], activeDraft: true })
    await draft.controller.newSession()
    expect(entries(draft).some((e) => e.kind === 'status' && e.text.endsWith(' It can still edit the open unsaved note.'))).toBe(true)
    await draft.controller.stop()
  })

  it('issue #29: a new note with no folder offers one, then writes through Allow Once', async () => {
    const home = folder()
    const notes = nodePath.join(home, 'Documents', 'Inkwell')
    const target = nodePath.join(notes, 'Fresh.md')
    const h = setup({
      root: '',
      target,
      agentEnv: { FAKE_ACP_CREATE: '1' },
      askNotesFolder: () => {
        mkdirSync(notes, { recursive: true })
        h.controller.setContext({ roots: [canonical(notes) as string] })
        return true
      }
    })
    h.controller.setContext({ roots: [] })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Make a note', includeNote: false })
    expect(h.offers).toEqual(['The agent wants to save a new note, but Inkwell has no notes folder yet.'])
    expect(h.prompts.map((p) => p.kind)).toEqual(['tool', 'write'])
    expect(h.prompts[1].detail).toBe('This creates a new file on disk.')
    expect(readFileSync(target, 'utf8')).toBe('\nSummary: added by the fake agent.\n')
    expect(h.written).toHaveLength(1)
    expect(h.written[0].created).toBe(true)
    await h.controller.stop()
  })

  it('issue #29: Not Now refuses the write, nothing is made, and the agent is told not to guess', async () => {
    const home = folder()
    const target = nodePath.join(home, 'Documents', 'Inkwell', 'Fresh.md')
    const h = setup({ root: '', target, agentEnv: { FAKE_ACP_CREATE: '1' }, askNotesFolder: () => false })
    h.controller.setContext({ roots: [] })
    await h.controller.newSession()
    await h.controller.prompt({ text: 'Make a note', includeNote: false })
    expect(h.offers).toHaveLength(1)
    expect(h.prompts.map((p) => p.kind)).toEqual(['tool']) // never a write sheet
    expect(existsSync(nodePath.join(home, 'Documents'))).toBe(false)
    expect(entries(h).find((e) => e.kind === 'toolCall')?.tool).toMatchObject({ status: 'failed', refusedBy: 'Inkwell' })
    await h.controller.stop()
  })

  it('issue #29: the menu and panel action only asks while the agent is on and no folder is shared', async () => {
    const root = folder()
    const asked: string[] = []
    const h = setup({ root: '', askNotesFolder: (message) => { asked.push(message); return true } })
    h.controller.setContext({ roots: [] })
    expect(await h.controller.addNotesFolder()).toBe(true)
    expect(asked).toEqual(['Add a notes folder for the agent?'])
    h.controller.setContext({ roots: [root] })
    expect(await h.controller.addNotesFolder()).toBe(false)
    expect(asked).toHaveLength(1)
    const off = setup({ root: '', enabled: false, askNotesFolder: () => { throw new Error('agent is off') } })
    off.controller.setContext({ roots: [] })
    expect(await off.controller.addNotesFolder()).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('starts a harness through an npm-style .cmd shim', async () => {
    const root = folder()
    const shimDir = nodePath.join(folder(), 'npm folder')
    mkdirSync(shimDir)
    const shim = nodePath.join(shimDir, 'fake-acp.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n`)
    const h = setup({ root })
    const env = (h.controller as unknown as { env: AgentEnvironment }).env
    env.prepareLaunch = async (_harness, cwd) => ({
      ...buildSpawn(shim, [], true, process.env.ComSpec), cwd, env: process.env as Record<string, string>, title: 'Shim'
    })
    expect(await h.controller.newSession()).toEqual({ ok: true })
    expect(h.controller.session?.agentTitle).toBe('Fake Agent')
    await h.controller.stop()
  })
})
