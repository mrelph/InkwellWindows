import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { LayoutPanelLeft } from 'lucide-react'
import { getFindActions, notifyFindContentChanged } from './findBridge'
import { indentEdit, outdentEdit, type TextEdit } from './findLogic'
import { applyTextEdit, revealOffset } from './textareaDom'

/* The Markdown source editor: the find/replace bar hooks, Tab capture, and
   the undo reset on document switch. EditorHandle is defined HERE and only
   here — App, the integrations context and FindController import it from this
   file. */

export type FindMode = 'find' | 'replace'

export type EditorSelection = { start: number; end: number; text: string }

export interface EditorHandle {
  /** The document the editor is showing right now. */
  readonly docId: string
  focus(): void
  getSelection(): EditorSelection
  /** Replaces the whole text as ONE undoable edit (Ctrl+Z restores the old
      text). Returns false if the edit could not go through the editor, in
      which case the caller falls back to a plain state update. */
  replaceAll(text: string): boolean
  /** Shows the find bar (Ctrl+F) or find-and-replace (Ctrl+H). */
  openFind(mode: FindMode): void
  /** F3 / Shift+F3. */
  findNext(): void
  findPrevious(): void
  /** Ctrl+E: puts the selection into the find field. */
  useSelectionForFind(): void
  /* Additions for the find bar (workstream B); other callers can ignore them. */
  /** The full current text. */
  getText(): string
  /** False when the textarea is not on screen (narrow split hides it). */
  isVisible(): boolean
  /** Selects [start, end) and scrolls it into view WITHOUT taking focus. */
  selectRange(start: number, end: number): void
  /** Replaces [start, end) as ONE undoable edit, leaving the caret after it
      and focus where it was. Returns false if the edit did not go through. */
  replaceRange(start: number, end: number, text: string): boolean
  /** Drops the undo history (remounts the textarea, as a document switch
      does), so Ctrl+Z cannot roll back past this point. Keeps the caret and
      scroll where they were, and focus if the editor had it. */
  resetHistory(): void
}

export type EditorProps = {
  docId: string
  content: string
  onChange: (content: string) => void
  ref?: Ref<EditorHandle>
}

export function Editor({ docId, content, onChange, ref }: EditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)

  /* Undo history belongs to one document. Mac drops it on a switch so Undo can
     never edit a note you cannot see, but keeps it across rename and save. The
     app gives a document a new id on both (draft:N becomes its path, a rename
     moves the path), so the id alone cannot tell them apart: a switch is an id
     change where the text is not the text the editor was just showing. The
     textarea is remounted (key) on a switch, which clears the native undo
     stack. */
  const shownContent = useRef(content)
  const [history, setHistory] = useState({ docId, generation: 0 })
  if (history.docId !== docId) {
    setHistory({ docId, generation: content === shownContent.current ? history.generation : history.generation + 1 })
  }
  useEffect(() => { shownContent.current = content }, [content])

  /* After resetHistory the fresh textarea gets the old caret, scroll and focus back. */
  const restore = useRef<{ start: number; end: number; scrollTop: number; focused: boolean } | null>(null)
  useEffect(() => {
    const element = textarea.current
    const saved = restore.current
    if (!element || !saved) return
    restore.current = null
    const length = element.value.length
    element.setSelectionRange(Math.min(saved.start, length), Math.min(saved.end, length))
    element.scrollTop = saved.scrollTop
    if (saved.focused) element.focus({ preventScroll: true })
  }, [history.generation])

  useImperativeHandle(ref, () => ({
    docId,
    focus: () => textarea.current?.focus(),
    getSelection: () => {
      const element = textarea.current
      if (!element) return { start: 0, end: 0, text: '' }
      const { selectionStart: start, selectionEnd: end, value } = element
      return { start, end, text: value.slice(start, end) }
    },
    replaceAll: (text: string) => {
      const element = textarea.current
      if (!element) return false
      if (element.value === text) return true
      /* insertText through the editing pipeline lands on the textarea's native
         undo stack as one step and fires the input event React listens to. */
      const previousFocus = document.activeElement as HTMLElement | null
      element.focus()
      element.select()
      const applied = document.execCommand('insertText', false, text)
      if (previousFocus && previousFocus !== element) previousFocus.focus()
      return applied && element.value === text
    },
    openFind: (mode: FindMode) => getFindActions()?.open(mode),
    findNext: () => getFindActions()?.next(),
    findPrevious: () => getFindActions()?.previous(),
    useSelectionForFind: () => getFindActions()?.useSelection(),
    getText: () => textarea.current?.value ?? '',
    isVisible: () => Boolean(textarea.current && textarea.current.offsetParent),
    selectRange: (start: number, end: number) => {
      const element = textarea.current
      if (!element) return
      element.setSelectionRange(start, end)
      revealOffset(element, start)
    },
    replaceRange: (start: number, end: number, text: string) => {
      const element = textarea.current
      if (!element) return false
      const previousFocus = document.activeElement as HTMLElement | null
      element.focus({ preventScroll: true })
      const scrollTop = element.scrollTop
      const caret = start + text.length
      const applied = applyTextEdit(element, { start, end, text, selStart: caret, selEnd: caret })
      element.scrollTop = scrollTop
      if (previousFocus && previousFocus !== element) previousFocus.focus({ preventScroll: true })
      return applied
    },
    resetHistory: () => {
      const element = textarea.current
      restore.current = element
        ? { start: element.selectionStart, end: element.selectionEnd, scrollTop: element.scrollTop, focused: document.activeElement === element }
        : null
      setHistory((current) => ({ ...current, generation: current.generation + 1 }))
    }
  }), [docId])

  /* The find bar's match count and highlights follow the text. */
  useEffect(() => { notifyFindContentChanged() }, [content, docId])

  /* Tab indents (two spaces, or every selected line); Shift+Tab outdents. Each
     is one undoable edit. Ctrl/Alt/Meta+Tab are left to the system, and the
     bar's own controls keep normal focus traversal. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
    event.preventDefault()
    const element = event.currentTarget
    const { selectionStart: start, selectionEnd: end, value } = element
    const edit: TextEdit | null = event.shiftKey ? outdentEdit(value, start, end) : indentEdit(value, start, end)
    if (!edit) return
    if (!applyTextEdit(element, edit)) {
      element.setRangeText(edit.text, edit.start, edit.end, 'end')
      element.setSelectionRange(edit.selStart, edit.selEnd)
      onChange(element.value)
    }
  }

  return (
    <div className="editor-panel">
      <div className="editor-bar">
        <span><LayoutPanelLeft size={15} /> Markdown source</span>
        <span className="statusbar-optional">{content.length.toLocaleString()} characters</span>
      </div>
      <textarea
        key={history.generation}
        ref={textarea}
        onKeyDown={onKeyDown}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        spellCheck="true"
        aria-label="Markdown source editor"
      />
    </div>
  )
}
