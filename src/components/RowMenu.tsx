import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

export type MenuItem = {
  key: string
  label: string
  icon: ReactNode
  run: () => void
  danger?: boolean
  separated?: boolean
}

/* The row actions. Opened by the row's ⋯ button or a right-click, positioned at
   the pointer and clamped into the window — Inkwell can be tiled into a very
   small rectangle, where an unclamped menu would open off-screen. */
export function RowMenu({ items, origin, onClose }: {
  items: MenuItem[]
  origin: { x: number; y: number }
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const ranItem = useRef(false)
  const [placed, setPlaced] = useState({ x: origin.x, y: origin.y, ready: false })

  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPlaced({
      x: Math.max(6, Math.min(origin.x, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(origin.y, window.innerHeight - height - 6)),
      ready: true
    })
  }, [origin.x, origin.y])

  /* Focus only once the menu is placed: it is hidden until then, and a hidden
     element cannot take focus — which left arrow keys doing nothing. */
  useEffect(() => {
    if (!placed.ready) return
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [placed.ready])

  /* Dismissing without choosing anything hands focus back to the control that
     opened the menu. Running an item does not: the item may well have moved
     focus itself, as Rename does. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => { if (!ranItem.current) opener?.focus?.() }
  }, [])

  useEffect(() => {
    const dismiss = () => onClose()
    const onPointerDown = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    /* Capture phase: the library scrolls inside its own container, so a bubbling
       listener on window would never see it and the menu would drift. */
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])

  /* Escape must not fall through to the window handler, which would also leave
     focus mode or close the outline. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    buttons[(next + buttons.length) % buttons.length].focus()
  }

  return (
    <div
      ref={panel}
      className="row-menu"
      role="menu"
      aria-label="Document actions"
      onKeyDown={onKeyDown}
      style={{ left: placed.x, top: placed.y, visibility: placed.ready ? 'visible' : 'hidden' }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          className={`${item.danger ? 'danger' : ''} ${item.separated ? 'separated' : ''}`.trim()}
          onClick={() => { ranItem.current = true; onClose(); item.run() }}
        >
          {item.icon} <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
