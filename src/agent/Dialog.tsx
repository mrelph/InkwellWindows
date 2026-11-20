import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* A modal sheet for the agent: permission and link confirmations. Portalled to
   <body> and position: fixed, so it shows even while the (still mounted)
   panel is collapsed and never takes a grid cell. Escape and a click outside
   both choose the safe answer. */

export type DialogButton = {
  label: string
  onClick: () => void
  /** The safe choice gets initial focus. */
  safe?: boolean
  primary?: boolean
}

export type DialogProps = {
  title: string
  children: ReactNode
  buttons: DialogButton[]
  onDismiss: () => void
  wide?: boolean
}

export function Dialog({ title, children, buttons, onDismiss, wide }: DialogProps) {
  const root = useRef<HTMLDivElement>(null)
  const previous = useRef<Element | null>(null)

  useEffect(() => {
    previous.current = document.activeElement
    const safe = root.current?.querySelector<HTMLButtonElement>('button[data-safe="true"]')
    ;(safe ?? root.current?.querySelector<HTMLButtonElement>('button'))?.focus()
    return () => {
      if (previous.current instanceof HTMLElement) previous.current.focus()
    }
  }, [])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      return
    }
    if (event.key !== 'Tab' || !root.current) return
    const focusable = [...root.current.querySelectorAll<HTMLElement>('button, [tabindex="0"]')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="agent-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss() }}>
      <div
        ref={root}
        className={`agent-dialog${wide ? ' wide' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <h2>{title}</h2>
        <div className="agent-dialog-body">{children}</div>
        <div className="agent-dialog-actions">
          {buttons.map((button) => (
            <button
              key={button.label}
              type="button"
              data-safe={button.safe ? 'true' : undefined}
              className={button.primary ? 'agent-button primary' : 'agent-button'}
              onClick={button.onClick}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
