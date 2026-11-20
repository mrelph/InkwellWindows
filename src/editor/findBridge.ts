import type { FindMode } from './Editor'

/* A tiny seam between the editor and the always-mounted FindController, so the
   EditorHandle's find methods (called by other modules) reach the same bar the
   keyboard commands drive, and the bar learns when the text changed. */

export type FindActions = {
  open(mode: FindMode): void
  next(): void
  previous(): void
  useSelection(): void
}

let actions: FindActions | null = null

export function setFindActions(next: FindActions | null): void {
  actions = next
}

export function getFindActions(): FindActions | null {
  return actions
}

const listeners = new Set<() => void>()

/** The editor's text (or the document under it) changed. */
export function notifyFindContentChanged(): void {
  for (const listener of listeners) listener()
}

export function subscribeFindContent(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
