import { useEffect, useId, useRef, useState } from 'react'
import type { DialogResult, DialogSpec } from './ephyHost'
import './EphyPicker.css'

/* The confirmations Mac shows as alert sheets: a title, some words, optionally
   a title field and a tick box, and one or two buttons. position: fixed — it
   sits beside the grid, never in it. */

export type EphyDialogProps = {
  spec: DialogSpec
  onClose: (result: DialogResult) => void
}

export function EphyDialog({ spec, onClose }: EphyDialogProps) {
  const [text, setText] = useState(spec.input?.value ?? '')
  const [checked, setChecked] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (spec.input) {
      inputRef.current?.focus()
      inputRef.current?.select()
      return
    }
    (spec.defaultCancel && spec.cancelLabel ? cancelRef.current : confirmRef.current)?.focus()
  }, [spec])

  const close = (confirmed: boolean) => onClose({ confirmed, text, checked })

  return (
    <div className="ephy-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && spec.cancelLabel) close(false) }}>
      <div
        className="ephy-dialog"
        role={spec.cancelLabel ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(false)
          } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          }
        }}
      >
        <h2 id={titleId} className="ephy-dialog-title">{spec.title}</h2>
        {spec.detail ? <p className="ephy-dialog-detail">{spec.detail}</p> : null}
        {spec.input ? (
          <label className="ephy-field">
            <span>{spec.input.label}</span>
            <input ref={inputRef} value={text} maxLength={200} spellCheck={false} onChange={(event) => setText(event.target.value)} />
          </label>
        ) : null}
        {spec.checkbox ? (
          <label className="ephy-check">
            <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
            <span>{spec.checkbox.label}</span>
          </label>
        ) : null}
        <div className="ephy-actions">
          {spec.cancelLabel ? <button ref={cancelRef} type="button" className="ephy-button" onClick={() => close(false)}>{spec.cancelLabel}</button> : null}
          <button ref={confirmRef} type="button" className={`ephy-button ${spec.destructive ? 'is-danger' : 'is-primary'}`} onClick={() => close(true)}>{spec.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
