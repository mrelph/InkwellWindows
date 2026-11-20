import { createContext, useContext } from 'react'

/* The document in front, for consumers outside the App tree's direct props —
   chiefly the agent panel. App provides it. */

export type ActiveDocumentInfo = {
  id: string
  name: string
  content: string
  /** Absent for drafts and Ephy notes. */
  path?: string
  sourceId: string
  isDirty: boolean
}

export type ActiveDocumentValue = {
  doc: ActiveDocumentInfo | null
  /** Replaces the active document's text. Goes through EditorHandle.replaceAll
      (one undoable edit) when the editor is showing this document, else a
      plain state update. Marks the document dirty; never writes to disk.
      Returns false when there is no active document. */
  applyEdit: (newText: string) => boolean
}

export const ActiveDocumentContext = createContext<ActiveDocumentValue>({
  doc: null,
  applyEdit: () => false
})

export const useActiveDocument = () => useContext(ActiveDocumentContext)
