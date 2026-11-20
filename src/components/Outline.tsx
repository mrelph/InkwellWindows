import { BookOpen, ChevronRight, X } from 'lucide-react'
import type { Heading } from '../lib/headings'

/* "On this page": the active document's h1–h3. Pinned to grid track 3. */

export type OutlineProps = {
  headings: Heading[]
  onSelect: (id: string) => void
  onClose: () => void
}

export function Outline({ headings, onSelect, onClose }: OutlineProps) {
  return (
    <aside className="outline" aria-label="Document outline">
      <div className="outline-heading">
        <span>On this page</span>
        <button className="icon-button" aria-label="Hide outline" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="outline-list">
        {headings.length ? headings.map((heading) => (
          <button key={heading.id} className={`outline-item level-${heading.level}`} onClick={() => onSelect(heading.id)}>
            <ChevronRight size={13} strokeWidth={1.7} /> {heading.text}
          </button>
        )) : <p className="empty-outline">Add headings to make a document outline.</p>}
      </div>
      <div className="outline-tip">
        <BookOpen size={16} strokeWidth={1.6} />
        <p>Reading view gives long notes a generous, distraction-free measure.</p>
      </div>
    </aside>
  )
}
