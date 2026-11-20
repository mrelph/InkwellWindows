import { useEffect, useRef } from 'react'

/* The command registry. Every action the keyboard, the application menu, the
   jump list or a button can trigger is a CommandId (declared once in
   src-electron/ipc/contract.ts). Handlers register from wherever the state
   they need lives; the shortcut dispatcher (src/app/shortcuts.ts) and
   `menu:command` both go through runCommand.

   Modules register handlers with useCommand. A new command needs its id in
   the CommandId union (ipc/contract.ts) and in COMMAND_IDS below. */

export type { CommandId } from '../../src-electron/ipc/contract'

/** Every command id, in menu order. Kept in step with the CommandId union by
    the `satisfies` check below. */
export const COMMAND_IDS = [
  'newNote', 'open', 'openRecent', 'openPath', 'clearRecent', 'addFolder', 'save', 'saveAs', 'closeDocument',
  'rename', 'duplicate', 'reveal', 'copyPath', 'trash',
  'find', 'replace', 'findNext', 'findPrevious', 'useSelectionForFind', 'findInDocuments',
  'viewRead', 'viewSplit', 'viewWrite', 'toggleLibrary', 'toggleOutline', 'focus',
  'zoomIn', 'zoomOut', 'zoomReset', 'setReaderFont', 'setAppearance', 'setTheme', 'toggleFullScreen', 'escape',
  'toggleAgentPanel', 'ephyOpen', 'ephySave', 'ephySaveAsNew', 'ephyOpenInBrowser', 'ephyGetLatest',
  'checkForUpdates'
] as const satisfies readonly CommandId[]

/* Compile-time completeness: fails if a CommandId is missing from the list. */
type MissingCommand = Exclude<CommandId, (typeof COMMAND_IDS)[number]>
const assertComplete: MissingCommand extends never ? true : MissingCommand = true
void assertComplete

/** `arg` carries a path (openRecent) or a value (setReaderFont). */
export type CommandHandler = (arg?: string) => void | Promise<void>

/* A stack per id: the most recent registration wins, and unregistering
   restores the one before it. That lets a mounted overlay (a find bar, a
   picker) temporarily own a command without coordinating with its owner. */
const handlers = new Map<CommandId, CommandHandler[]>()

export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
  const stack = handlers.get(id) ?? []
  stack.push(handler)
  handlers.set(id, stack)
  return () => {
    const current = handlers.get(id)
    if (!current) return
    const index = current.lastIndexOf(handler)
    if (index >= 0) current.splice(index, 1)
    if (!current.length) handlers.delete(id)
  }
}

export function hasCommand(id: CommandId): boolean {
  return Boolean(handlers.get(id)?.length)
}

/** Runs the newest handler for `id`. Returns false when nothing is registered
    (a stub workstream has not landed yet) — that is not an error. */
export function runCommand(id: CommandId, arg?: string): boolean {
  const stack = handlers.get(id)
  const handler = stack?.[stack.length - 1]
  if (!handler) return false
  /* Synchronous, so a handler still runs inside the key event that caused it. */
  try {
    const result = handler(arg)
    if (result instanceof Promise) result.catch((error: unknown) => console.warn(`Command ${id} failed`, error))
  } catch (error) {
    console.warn(`Command ${id} failed`, error)
  }
  return true
}

/** Registers `handler` for the component's lifetime. The latest closure is
    always the one that runs, so handlers need no dependency arrays. */
export function useCommand(id: CommandId, handler: CommandHandler, enabled = true): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!enabled) return
    return registerCommand(id, (arg) => latest.current(arg))
  }, [id, enabled])
}
