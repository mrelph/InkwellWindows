import type { TextEdit } from './findLogic'

/* DOM helpers for the source textarea: undoable edits and scroll-to-offset. */

/** Applies `edit` as ONE step on the native undo stack (execCommand goes
    through the editing pipeline, so Ctrl+Z works and React sees an input
    event). Returns false if the browser refused, with the textarea untouched. */
export function applyTextEdit(element: HTMLTextAreaElement, edit: TextEdit): boolean {
  const before = element.value
  element.setSelectionRange(edit.start, edit.end)
  const ok = edit.text === ''
    ? document.execCommand('delete')
    : document.execCommand('insertText', false, edit.text)
  const expected = before.slice(0, edit.start) + edit.text + before.slice(edit.end)
  if (!ok || element.value !== expected) {
    element.setSelectionRange(edit.start, edit.end) // restore for the caller's fallback
    return false
  }
  element.setSelectionRange(edit.selStart, edit.selEnd)
  return true
}

const MIRRORED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize',
  'textTransform', 'wordSpacing', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
] as const

/** Scrolls the textarea so the character at `offset` is on screen (centered
    when it was out of view). Measures wrapped text with an off-screen mirror,
    because a textarea has no API for "where is offset N". Does not move focus
    or the selection. */
export function revealOffset(element: HTMLTextAreaElement, offset: number): void {
  const style = getComputedStyle(element)
  const mirror = document.createElement('div')
  for (const property of MIRRORED) mirror.style[property] = style[property]
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    boxSizing: 'border-box',
    border: '0',
    width: `${element.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word'
  })
  mirror.textContent = element.value.slice(0, offset)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  mirror.remove()

  const parsed = parseFloat(style.lineHeight)
  const lineHeight = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.4
  const viewTop = element.scrollTop
  const viewBottom = viewTop + element.clientHeight
  if (top < viewTop + lineHeight || top + lineHeight * 2 > viewBottom) {
    element.scrollTop = Math.max(0, top - element.clientHeight / 2 + lineHeight / 2)
  }
}
