import { FilePlus2, FileText, FolderPlus } from 'lucide-react'
import { EphyOpenButton } from '../ephy/EphyPicker'

/* The canvas when nothing is open — a legitimate state, not an error (Mac
   ContentView.EmptyCanvas): one quiet line in the reading font and the ways
   to start, using the same actions as the menus and the library header. The
   buttons sit in a row while they fit and stack at one shared width when they
   do not (styles.css, `.canvas-empty`), so nothing clips at 140% zoom. */

export type EmptyStateProps = {
  onNewNote: () => void
  onOpen: () => void
  onAddFolder: () => void
}

export function EmptyState({ onNewNote, onOpen, onAddFolder }: EmptyStateProps) {
  return (
    <div className="document-canvas view-read">
      <div className="canvas-empty">
        <h2>Open a note, add a folder, or start writing.</h2>
        <div className="canvas-empty-actions">
          <button title="New note (Ctrl+N)" onClick={onNewNote}><FilePlus2 size={15} strokeWidth={1.7} /> New note</button>
          <button title="Open a Markdown file (Ctrl+O)" onClick={onOpen}><FileText size={15} strokeWidth={1.7} /> Open file</button>
          <button title="Add a folder to the library (Ctrl+Shift+O)" onClick={onAddFolder}><FolderPlus size={15} strokeWidth={1.7} /> Add folder</button>
          <EphyOpenButton />
        </div>
      </div>
    </div>
  )
}
