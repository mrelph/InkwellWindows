import { Clock3 } from 'lucide-react'
import { UpdateNotice } from '../update/UpdateNotice'

/* The status bar. Hidden in focus mode by styles.css. */

export type StatusBarProps = {
  words: number
  sections: number
}

export function StatusBar({ words, sections }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span><Clock3 size={14} /> {words} words</span>
      <span className="statusbar-optional">{sections} sections</span>
      <UpdateNotice />
      <span className="statusbar-end statusbar-optional">Markdown · UTF-8</span>
    </footer>
  )
}
