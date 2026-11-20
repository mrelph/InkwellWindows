import { randomUUID } from 'node:crypto'
import { app, dialog, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { handle, on } from '../ipcGuard'
import { trustAndReadLibraryFolder } from '../ipc/documents'
import { adoptFolderInRenderer, registerLibraryAdopt } from '../libraryAdopt'
import { createNotesFolder, defaultNotesFolderPath } from './notesFolder'
import nodePath from 'node:path'
import { getSetting, setSetting } from '../settings'
import type {
  AgentBufferRequest,
  AgentContext,
  AgentEvent,
  AgentHarnessId,
  AgentHarnessInfo,
  AgentPermissionRequest,
  AgentPromptPayload,
  AgentResult,
  AgentSessionState
} from '../ipc/contract'
import { AgentController, type BufferAnswer, type BufferQuery, type PermissionPrompt } from './controller'
import { HARNESS_DEFINITIONS } from './harness'
import { isKnownLibraryFolder, mayReadDocument } from '../trustedDocuments'
import { canonical } from './pathSandbox'
import { PathSpellings } from './spellings'

/* The optional agent panel's main side: Inkwell as an Agent Client Protocol
   client (JSON-RPC over a child process's stdio) for Kiro CLI, Codex and
   Claude Code — the port of InkwellMac Sources/InkwellCore/ACP/*. Owned by the
   agent workstream (G); everything under src-electron/acp/ is G's.

   Rules carried over from the Mac:
   - Off by default. While disabled nothing is looked up and no process starts.
   - Advertise fs.readTextFile / fs.writeTextFile only, never terminal.
   - File access is sandboxed to the library folders and the open note's folder
     (AgentContext); hidden paths are refused.
   - Writes ask first (allow-once sheet with a line diff, `agent:permission-request`
     kind 'write'). A write to an OPEN note goes to the renderer as one
     undoable edit (`agent:buffer-request` op 'write') and never to disk.
   - Reads of an open note come from its buffer (`agent:buffer-request` op 'read').

   This file is the Electron seam only: IPC, the window, settings. The session
   logic lives in controller.ts and the pieces beside it, none of which import
   Electron, so they run under vitest. */

const BUFFER_TIMEOUT_MS = 15_000
const MAX_FIELD = 4000

let registered = false
let current: BrowserWindow | null = null

/* Every open note and library folder as the renderer named it, keyed by real
   path. The sandbox hands the file layer real paths (symlinks, junctions,
   mapped drives and 8.3 short names resolved), while the renderer knows each
   note by the path it opened; buffer requests and file-written events are
   sent under the renderer's spelling, so a note opened through a junction or
   a short name still routes to its buffer, not to disk (spellings.ts). */
const spellings = new PathSpellings(canonical)

/** The renderer's spelling of `resolved`. */
const rendererPath = (resolved: string) => spellings.toRenderer(resolved)

const pendingPermissions = new Map<string, { optionIds: Set<string>; resolve: (optionId: string | null) => void }>()
const pendingBuffers = new Map<string, (answer: BufferAnswer) => void>()

const sendToWindow = (channel: string, payload: unknown) => {
  if (current && !current.isDestroyed()) current.webContents.send(channel, payload)
}

const emit = (event: AgentEvent) => sendToWindow('agent:event', event)

const cut = (text: string, limit = MAX_FIELD) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

function askPermission(prompt: PermissionPrompt): Promise<string | null> {
  if (!current || current.isDestroyed()) return Promise.resolve(null)
  const requestId = randomUUID()
  const request: AgentPermissionRequest = {
    requestId,
    kind: prompt.kind,
    title: cut(prompt.title, 500),
    detail: cut(prompt.detail),
    options: prompt.options.slice(0, 8).map((option) => ({
      optionId: option.optionId,
      name: cut(option.name, 200),
      kind: option.kind
    })),
    ...(prompt.path ? { path: cut(prompt.path, 1000) } : {}),
    ...(prompt.diff ? { diff: prompt.diff } : {})
  }
  return new Promise<string | null>((resolve) => {
    pendingPermissions.set(requestId, { optionIds: new Set(request.options.map((option) => option.optionId)), resolve })
    sendToWindow('agent:permission-request', request)
  })
}

function dismissSheets(): void {
  for (const [id, entry] of [...pendingPermissions]) {
    pendingPermissions.delete(id)
    entry.resolve(null)
  }
}

function askBuffer(query: BufferQuery): Promise<BufferAnswer> {
  if (!current || current.isDestroyed()) return Promise.resolve({ open: false })
  const requestId = randomUUID()
  const path = query.draft ? query.path : rendererPath(query.path)
  const draft = query.draft ? { draft: true, ...(query.docId ? { docId: query.docId } : {}) } : {}
  const request: AgentBufferRequest = query.op === 'read'
    ? { requestId, op: 'read', path, ...draft }
    : { requestId, op: 'write', path, content: query.content, ...draft }
  return new Promise<BufferAnswer>((resolve) => {
    const timer = setTimeout(() => {
      pendingBuffers.delete(requestId)
      resolve({ open: false })
    }, BUFFER_TIMEOUT_MS)
    pendingBuffers.set(requestId, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    sendToWindow('agent:buffer-request', request)
  })
}

/** Where "Create" makes the notes folder: `Documents\Inkwell`. An isolated run
    (a custom --user-data-dir, as tests use) gets a fake home inside its data
    folder, so a test never touches the real Documents. */
function notesFolderPath(): string {
  const documents = app.commandLine.hasSwitch('user-data-dir')
    ? nodePath.join(app.getPath('userData'), 'Home', 'Documents')
    : app.getPath('documents')
  return defaultNotesFolderPath(documents)
}

const tell = (window: BrowserWindow, message: string) =>
  dialog.showMessageBox(window, { type: 'warning', message, buttons: ['OK'], noLink: true }).then(() => undefined, () => undefined)

/** The native, window-modal "add a notes folder" dialog: Create (default) /
    Choose Folder… / Not Now. The folder is trusted by main and adopted by the
    renderer before this resolves true; the renderer never grants the trust. */
async function askNotesFolder(message: string): Promise<boolean> {
  const window = current
  if (!window || window.isDestroyed()) return false
  const target = notesFolderPath()
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Notes folder',
    message,
    detail: 'Notes the agent creates are saved in a library folder, after you allow each one.',
    buttons: [`Create ${target}`, 'Choose Folder…', 'Not Now'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })
  let folder: string
  if (response === 0) {
    const real = createNotesFolder(target)
    if (!real) {
      await tell(window, `Could not create ${target}`)
      return false
    }
    folder = real
  } else if (response === 1) {
    const selection = await dialog.showOpenDialog(window, { title: 'Open a folder', properties: ['openDirectory'] })
    if (selection.canceled || !selection.filePaths[0]) return false
    folder = selection.filePaths[0]
  } else {
    return false
  }
  const result = await trustAndReadLibraryFolder(folder)
  if (result.refused) {
    await tell(window, result.refused)
    return false
  }
  if (!result.folder || !await adoptFolderInRenderer(result)) return false
  // The renderer pushed its agent context before it answered.
  return !controller.needsNotesFolder()
}

const controller = new AgentController({
  isEnabled: () => getSetting('agentEnabled'),
  getHarness: () => getSetting('agentHarness'),
  emit,
  askPermission,
  askBuffer,
  askNotesFolder,
  dismissSheets,
  onFileWritten: (path, created) => sendToWindow('agent:file-written', { path: rendererPath(path), created }),
  fallbackDirectory: () => nodePath.join(app.getPath('userData'), 'Agent'),
  clientVersion: app.getVersion(),
  home: app.getPath('home')
})

export function isAgentEnabled(): boolean {
  return getSetting('agentEnabled')
}

/** Turning the agent off stops any running session. Main-only: called from
    the Integrations menu, never from the renderer. */
export function setAgentEnabled(on: boolean): boolean {
  const next = setSetting('agentEnabled', on === true)
  if (!next) void controller.stop()
  emit({ type: 'state', state: agentState() })
  return next
}

/** The library has no folders, so the agent has nowhere to save. */
export function needsNotesFolder(): boolean {
  return controller.needsNotesFolder()
}

const notesFolderListeners = new Set<() => void>()

/** Hears every time `needsNotesFolder()` flips (the menu item follows it). */
export function onNotesFolderNeedChange(listener: () => void): () => void {
  notesFolderListeners.add(listener)
  return () => { notesFolderListeners.delete(listener) }
}

/** Integrations ▸ Agent ▸ Add Notes Folder…: the dialog, then the folder in
    the library. Main-only; false when declined or not applicable. */
export function addNotesFolder(): Promise<boolean> {
  return controller.addNotesFolder()
}

/** The harness the menu shows as chosen. */
export function getAgentHarness(): AgentHarnessId {
  return getSetting('agentHarness')
}

export function agentState(): AgentSessionState {
  return controller.state()
}

/** The sandbox roots and active note last pushed by the renderer. */
export function getAgentContext(): AgentContext {
  return controller.context
}

/** Stops the child process (and anything it started), if any. Called on
    window close and quit; it does not wait. */
export function shutDownAgent(): void {
  controller.forceKill()
  dismissSheets()
}

const harnessIds = HARNESS_DEFINITIONS.map((harness) => harness.id)
const isHarnessId = (value: unknown): value is AgentHarnessId => harnessIds.includes(value as AgentHarnessId)

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length <= limit ? value : undefined

/** The renderer's prompt, re-validated: it crossed a process boundary. */
function sanitizePrompt(value: unknown): AgentPromptPayload | null {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  const body = record ? text(record.text, 200_000) : undefined
  if (!record || body === undefined) return null
  const payload: AgentPromptPayload = { text: body, includeNote: record.includeNote === true }
  const note = typeof record.note === 'object' && record.note !== null ? record.note as Record<string, unknown> : null
  const name = note ? text(note.name, 300) : undefined
  const content = note ? text(note.content, 16 * 1024 * 1024) : undefined
  if (note && name !== undefined && content !== undefined) {
    payload.note = {
      name,
      content,
      unsaved: note.unsaved === true,
      ...(typeof note.path === 'string' && note.path ? { path: note.path } : {}),
      ...(typeof note.docId === 'string' && note.docId && note.docId.length <= 500 ? { docId: note.docId } : {})
    }
  }
  return payload
}

const fromWindow = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  Boolean(current && !current.isDestroyed() && event.sender === current.webContents)

/** Registers once; later calls rebind the window events are sent to. */
export function registerAgentIpc(window: BrowserWindow): void {
  current = window
  registerLibraryAdopt(window)
  if (registered) return
  registered = true

  handle('agent:get-enabled', () => isAgentEnabled())
  handle('agent:get-include-note', () => getSetting('agentIncludeNote'))
  handle('agent:set-include-note', (_event, value: unknown) => setSetting('agentIncludeNote', value === true))
  handle('agent:list-harnesses', (): Promise<AgentHarnessInfo[]> => controller.listHarnesses())
  on('agent:open-harness-help', (_event, id: unknown) => {
    const harness = HARNESS_DEFINITIONS.find((entry) => entry.id === id)
    if (harness) void shell.openExternal(harness.helpUrl)
  })
  handle('agent:get-state', (event) => {
    // A reloaded renderer lost the transcript; send it again after the answer.
    if (fromWindow(event)) setImmediate(() => controller.replay())
    return agentState()
  })
  handle('agent:start', async (event, harness: unknown): Promise<AgentResult> => {
    if (!fromWindow(event)) return { ok: false, message: 'Not available.' }
    if (!isAgentEnabled()) return { ok: false, message: 'The agent is turned off.' }
    if (!isHarnessId(harness)) return { ok: false, message: 'Unknown agent.' }
    setSetting('agentHarness', harness)
    return controller.newSession(harness)
  })
  handle('agent:new-session', async (event): Promise<AgentResult> =>
    fromWindow(event) ? controller.newSession() : { ok: false, message: 'Not available.' })
  handle('agent:prompt', async (event, payload: unknown): Promise<AgentResult> => {
    if (!fromWindow(event)) return { ok: false, message: 'Not available.' }
    const clean = sanitizePrompt(payload)
    if (!clean) return { ok: false, message: 'That message could not be sent.' }
    setSetting('agentIncludeNote', clean.includeNote)
    return controller.prompt(clean)
  })
  on('agent:cancel', (event) => { if (fromWindow(event)) controller.cancel() })
  on('agent:stop', (event) => { if (fromWindow(event)) void controller.stop() })
  on('agent:set-context', (event, next: unknown) => {
    if (!fromWindow(event)) return
    const record = typeof next === 'object' && next !== null ? next as Record<string, unknown> : {}
    /* Only what main vouched for, checked lexically BEFORE any realpath: the
       library folders it knows, and documents it handed out. A renderer
       naming anything else (a UNC path, a folder it made up) is ignored. */
    const roots = (Array.isArray(record.roots) ? record.roots : [])
      .filter((root): root is string => isKnownLibraryFolder(root))
      .slice(0, 16)
    const activePath = mayReadDocument(record.activePath) ? record.activePath : undefined
    const openPaths = (Array.isArray(record.openPaths) ? record.openPaths : [])
      .filter((entry): entry is string => mayReadDocument(entry))
      .slice(0, 5000)
    if (activePath && !openPaths.includes(activePath)) openPaths.push(activePath)
    spellings.update(openPaths, roots)
    const needed = controller.needsNotesFolder()
    controller.setContext({ roots, activePath, openPaths, activeDraft: record.activeDraft === true })
    if (needed !== controller.needsNotesFolder()) for (const listener of notesFolderListeners) listener()
  })
  handle('agent:add-notes-folder', async (event): Promise<boolean> =>
    fromWindow(event) ? controller.addNotesFolder() : false)
  on('agent:permission-response', (event, response: unknown) => {
    if (!fromWindow(event)) return
    const record = typeof response === 'object' && response !== null ? response as Record<string, unknown> : {}
    const entry = typeof record.requestId === 'string' ? pendingPermissions.get(record.requestId) : undefined
    if (!entry || typeof record.requestId !== 'string') return
    pendingPermissions.delete(record.requestId)
    // Only an option that was offered counts; anything else is a cancel.
    entry.resolve(typeof record.optionId === 'string' && entry.optionIds.has(record.optionId) ? record.optionId : null)
  })
  on('agent:buffer-response', (event, response: unknown) => {
    if (!fromWindow(event)) return
    const record = typeof response === 'object' && response !== null ? response as Record<string, unknown> : {}
    const id = typeof record.requestId === 'string' ? record.requestId : undefined
    const resolve = id ? pendingBuffers.get(id) : undefined
    if (!id || !resolve) return
    pendingBuffers.delete(id)
    if (record.open !== true) resolve({ open: false })
    else if (typeof record.content === 'string') resolve({ open: true, content: record.content })
    else resolve({ open: true, applied: record.applied === true })
  })
}
