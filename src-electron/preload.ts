import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
/* Type-only: the renderer is sandboxed, so this file may never import a local
   module at runtime. `import type` is erased by tsc. Channel names are string
   literals for the same reason; they mirror CHANNELS in ipc/contract.ts. */
import type {
  AgentBufferResponse,
  AgentContext,
  AgentHarnessId,
  AgentPermissionResponse,
  AgentPromptPayload,
  InkwellBridge,
  LibraryAdoptResponse,
  LinkOpenRequest,
  InkwellState,
  MenuState,
  SavePayload
} from './ipc/contract'

/* Each subscription returns its own disposer so the renderer can detach without
   removing another listener's handler. */
const subscribe = <T,>(channel: string, listener: (payload: T) => void) => {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

const bridge = {
  platform: process.platform,
  openDocuments: () => ipcRenderer.invoke('document:open'),
  openFolder: () => ipcRenderer.invoke('document:open-folder'),
  readFolder: (folder: string) => ipcRenderer.invoke('document:read-folder', folder),
  readDocuments: (paths: string[]) => ipcRenderer.invoke('document:read', paths),
  openLink: (request: LinkOpenRequest) => ipcRenderer.invoke('document:open-link', request),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state: InkwellState) => ipcRenderer.send('state:save', state),
  setZoomLevel: (percent: number) => {
    if (!Number.isFinite(percent)) return
    webFrame.setZoomFactor(Math.min(1.4, Math.max(0.8, percent / 100)))
  },
  renameDocument: (payload: { path: string; name: string }) => ipcRenderer.invoke('file:rename', payload),
  duplicateDocument: (filePath: string) => ipcRenderer.invoke('file:duplicate', filePath),
  trashDocument: (filePath: string) => ipcRenderer.invoke('file:trash', filePath),
  confirmTrash: (name: string) => ipcRenderer.invoke('file:confirm-trash', name),
  revealDocument: (filePath: string) => ipcRenderer.send('file:reveal', filePath),
  copyText: (text: string) => ipcRenderer.send('clipboard:write', text),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  dismissUpdate: (version: string) => ipcRenderer.send('update:dismiss', version),
  openUpdate: () => ipcRenderer.send('update:open'),
  onUpdateAvailable: (listener) => subscribe('update:available', listener),
  saveDocument: (payload: SavePayload) => ipcRenderer.invoke('document:save', payload),
  setDirty: (isDirty: boolean) => ipcRenderer.send('document:set-dirty', isDirty),
  confirmDiscard: (names: string) => ipcRenderer.invoke('document:confirm-discard', names),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (listener) => subscribe('theme:changed', listener),
  setAppearance: (choice) => ipcRenderer.send('theme:set-appearance', choice),
  onOpenExternal: (listener) => subscribe('document:opened-externally', listener),

  menu: {
    setState: (state: MenuState) => ipcRenderer.send('menu:state', state),
    onCommand: (listener) => subscribe('menu:command', listener)
  },

  fullScreen: {
    toggle: () => ipcRenderer.send('window:toggle-fullscreen'),
    get: () => ipcRenderer.invoke('window:get-fullscreen'),
    onChange: (listener) => subscribe('window:fullscreen-changed', listener)
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (listener) => subscribe('update:status', listener),
    getAutoCheck: () => ipcRenderer.invoke('update:get-auto-check'),
    setAutoCheck: (on: boolean) => ipcRenderer.invoke('update:set-auto-check', on),
    onAutoCheckChange: (listener) => subscribe('update:auto-check-changed', listener)
  },

  spellcheck: {
    get: () => ipcRenderer.invoke('spellcheck:get'),
    set: (on: boolean) => ipcRenderer.invoke('spellcheck:set', on),
    onChange: (listener) => subscribe('spellcheck:changed', listener)
  },

  agent: {
    getEnabled: () => ipcRenderer.invoke('agent:get-enabled'),
    onEnabledChange: (listener) => subscribe('agent:enabled-changed', listener),
    getIncludeNote: () => ipcRenderer.invoke('agent:get-include-note'),
    setIncludeNote: (on: boolean) => ipcRenderer.invoke('agent:set-include-note', on),
    listHarnesses: () => ipcRenderer.invoke('agent:list-harnesses'),
    openHarnessHelp: (harness: AgentHarnessId) => ipcRenderer.send('agent:open-harness-help', harness),
    getState: () => ipcRenderer.invoke('agent:get-state'),
    start: (harness: AgentHarnessId) => ipcRenderer.invoke('agent:start', harness),
    newSession: () => ipcRenderer.invoke('agent:new-session'),
    prompt: (payload: AgentPromptPayload) => ipcRenderer.invoke('agent:prompt', payload),
    cancel: () => ipcRenderer.send('agent:cancel'),
    stop: () => ipcRenderer.send('agent:stop'),
    setContext: (context: AgentContext) => ipcRenderer.send('agent:set-context', context),
    onEvent: (listener) => subscribe('agent:event', listener),
    onPermissionRequest: (listener) => subscribe('agent:permission-request', listener),
    respondPermission: (response: AgentPermissionResponse) => ipcRenderer.send('agent:permission-response', response),
    onBufferRequest: (listener) => subscribe('agent:buffer-request', listener),
    respondBuffer: (response: AgentBufferResponse) => ipcRenderer.send('agent:buffer-response', response),
    onFileWritten: (listener) => subscribe('agent:file-written', listener),
    addNotesFolder: () => ipcRenderer.invoke('agent:add-notes-folder')
  },

  library: {
    onAdoptFolder: (listener) => subscribe('library:adopt-folder', listener),
    respondAdoptFolder: (response: LibraryAdoptResponse) => ipcRenderer.send('library:adopt-folder-result', response)
  },

  ephy: {
    getEnabled: () => ipcRenderer.invoke('ephy:get-enabled'),
    onEnabledChange: (listener) => subscribe('ephy:enabled-changed', listener),
    status: () => ipcRenderer.invoke('ephy:status'),
    list: (request: { cursor?: string; limit?: number }) => ipcRenderer.invoke('ephy:list', request),
    open: (id: string) => ipcRenderer.invoke('ephy:open', id),
    save: (request: { id: string; content: string; baseVersion?: number }) => ipcRenderer.invoke('ephy:save', request),
    saveAsNew: (request: { title: string; content: string }) => ipcRenderer.invoke('ephy:save-as-new', request),
    openInBrowser: (id: string) => ipcRenderer.invoke('ephy:open-in-browser', id),
    getLatest: (request: { id: string; version?: number }) => ipcRenderer.invoke('ephy:get-latest', request)
  }
} satisfies InkwellBridge

contextBridge.exposeInMainWorld('inkwell', bridge)
