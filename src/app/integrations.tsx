import { createContext, useContext } from 'react'
import type { FolderSource, MarkdownDoc } from '../lib/library'

/* What the integrations (agent panel, Ephy) may read and change in the
   library, without editing App. App provides it. */

export type DocumentPatch = Partial<Pick<MarkdownDoc, 'name' | 'isDirty' | 'ephy' | 'savedAt'>>

/** A document's new identity: what Ephy "Save as New" does to a draft or an
    Ephy note, which becomes the new artifact's note (Mac EphyController). */
export type DocumentRekey = Pick<MarkdownDoc, 'id' | 'sourceId'> & DocumentPatch

export type IntegrationsValue = {
  /** Every open document (read-only snapshot). */
  documents: MarkdownDoc[]
  folders: FolderSource[]
  /** Local files linked to Ephy artifacts, by absolute path. Persisted in library.json. */
  ephyLinks: Record<string, EphyLink>
  /** Sets or (with null) removes a link. Capped at MAX_EPHY_LINKS. */
  setEphyLink: (path: string, link: EphyLink | null) => void
  /** Adds a document that has no file (an Ephy note: sourceId EPHY, id
      `ephy:<artifactId>`), or activates it if already open. Never touches
      Recent or library.json. */
  addInMemoryDocument: (doc: MarkdownDoc) => void
  /** Patches metadata of a document by id. Content goes through applyEditTo. */
  updateDocument: (id: string, patch: DocumentPatch) => void
  /** Gives the document `oldId` a new id and source (and any metadata in the
      patch), moving `activeId` with it the way a rename does. Content and
      revision are kept. A document already holding the new id is replaced.
      False when `oldId` is not open. Never touches Recent or library.json. */
  rekeyDocument: (oldId: string, next: DocumentRekey) => boolean
  /** Drops the editor's undo history for this document, if the editor is
      showing it — after a replacement that undo must not roll back (Ephy Get
      Latest: the stored version is already the new one). */
  resetUndo: (id: string) => void
  /** Replaces a document's text as one undoable edit when the editor shows
      it, else a state update. Marks dirty; no disk write. False if not open. */
  applyEditTo: (id: string, newText: string) => boolean
  /** Shows a line in the header's status line. */
  notify: (text: string) => void
  agentOpen: boolean
  setAgentOpen: (open: boolean) => void
  /** The enable toggles, kept in step with main by `agent:enabled-changed` /
      `ephy:enabled-changed`, whichever surface flipped them. */
  agentEnabled: boolean
  ephyEnabled: boolean
}

export const IntegrationsContext = createContext<IntegrationsValue>({
  documents: [],
  folders: [],
  ephyLinks: {},
  setEphyLink: () => undefined,
  addInMemoryDocument: () => undefined,
  updateDocument: () => undefined,
  rekeyDocument: () => false,
  resetUndo: () => undefined,
  applyEditTo: () => false,
  notify: () => undefined,
  agentOpen: false,
  setAgentOpen: () => undefined,
  agentEnabled: false,
  ephyEnabled: false
})

export const useIntegrations = () => useContext(IntegrationsContext)
