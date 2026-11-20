import type { EphyLink } from '../../src-electron/ipc/contract'
import type { MarkdownDoc } from '../lib/library'
import type { DocumentPatch, DocumentRekey } from '../app/integrations'

/* What the Ephy flows need from the running app, without importing React.
   EphyPicker (always mounted) binds the live values here; ephyClient.ts reads
   them through `host()`. When nothing is bound (outside the app, in tests) the
   flows refuse politely. */

export type DialogSpec = {
  title: string
  detail?: string
  confirmLabel: string
  /** Null for a one-button notice. */
  cancelLabel: string | null
  destructive?: boolean
  /** Return (Enter) answers the cancel button: for a destructive replace. */
  defaultCancel?: boolean
  /** A single-line field, prefilled. */
  input?: { label: string; value: string }
  /** A tick box, unticked. */
  checkbox?: { label: string }
}

export type DialogResult = { confirmed: boolean; text: string; checked: boolean }

export type EphyHost = {
  ask: (spec: DialogSpec) => Promise<DialogResult>
  documents: () => MarkdownDoc[]
  ephyLinks: () => Record<string, EphyLink>
  addInMemoryDocument: (doc: MarkdownDoc) => void
  updateDocument: (id: string, patch: DocumentPatch) => void
  /** Moves a document to a new id/source (Save as New on a draft or Ephy note). */
  rekeyDocument: (oldId: string, next: DocumentRekey) => boolean
  /** Clears the editor's undo history for this document (after Get Latest). */
  resetUndo: (id: string) => void
  applyEditTo: (id: string, text: string) => boolean
  setEphyLink: (path: string, link: EphyLink | null) => void
  notify: (text: string) => void
}

let bound: EphyHost | null = null

export const bindHost = (next: EphyHost | null): void => {
  bound = next
}

export const host = (): EphyHost | null => bound
