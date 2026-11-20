import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/* Responsive chrome: which panels fit, where the split collapses, and which
   header stage to draw. Owned by the design workstream (E). A port of Mac's
   `AppModel.widthChanged` / `layoutWidth` / `effectiveView` and
   `ChromeLayout.HeaderStage`.

   Every breakpoint compares against the LAYOUT width, not the window width:

   - Zoom. Inkwell zooms with Electron's page zoom, which shrinks the CSS
     viewport, so `window.innerWidth` is already "window ÷ zoom" — the same
     CSS-zoom semantics Mac reproduces by hand. Nothing to divide here.
   - The agent panel. A docked agent panel takes its column out of the width
     the rules see, so the outline and library fold as if the window were that
     much narrower. Media queries cannot know about it, which is why the
     breakpoints are published as `data-chrome` tokens on the root element and
     styles.css keys on those instead of on `@media (max-width)`.

   App passes the returned object to Header untouched, so new fields need no
   App change. */

/** The outline loses its own column (and overlays the canvas) at or below this. */
export const OUTLINE_OVERLAY_WIDTH = 1120
/** The library folds away, and a split collapses to one pane, at or below this. */
export const SPLIT_COLLAPSE_WIDTH = 820
/** The status bar keeps only the word count at or below this (Mac StatusBar). */
export const STATUS_COMPACT_WIDTH = 700
/** Quarter-tile territory: the reader tightens its gutters. */
export const SMALL_WIDTH = 560
/** The smallest layout width the app is built for (Mac `minLayoutWidth`). */
export const MIN_LAYOUT_WIDTH = 480
/** The agent panel's docked column — `--col-agent` in styles.css. */
export const AGENT_PANEL_WIDTH = 340

/* Kept for callers that only need the window-level answer before React has
   mounted (initialOutlineOpen). The live breakpoints are the constants above. */
export const OUTLINE_OVERLAY_QUERY = `(max-width: ${OUTLINE_OVERLAY_WIDTH}px)`
export const SIDEBAR_TIGHT_QUERY = `(max-width: ${SPLIT_COLLAPSE_WIDTH}px)`

export type ResponsiveChrome = {
  /** The outline is an overlay rather than a docked column. */
  outlineOverlay: boolean
  /** At or below the split breakpoint: the library is folded by default and a
      split draws one pane (the reader; the editor in focus + split). */
  sidebarTight: boolean
  /** The agent panel is open but too wide to dock, so it overlays the canvas. */
  agentOverlay: boolean
  /** Window width less a docked agent panel, in CSS px (zoom already applied). */
  layoutWidth: number
}

export type ChromePanels = {
  outlineOpen: boolean
  setOutlineOpen: (open: boolean) => void
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  /** A docked agent panel narrows the layout width; focus mode hides it. */
  agentOpen: boolean
  focusMode: boolean
}

/** Only open by default where the outline gets a real column. Below that it
    overlays the canvas, and a tiled window should start on the document. */
export const initialOutlineOpen = () =>
  typeof window === 'undefined' || !window.matchMedia(OUTLINE_OVERLAY_QUERY).matches

/* ------------------------------------------------------------------ layout */

export type LayoutInput = { windowWidth: number; agentOpen: boolean; focusMode: boolean }

/** Mac `ChromeLayout.agentPanelDocks` + `AppModel.layoutWidth`. The agent
    panel docks as a column only while the document beside it keeps the app's
    minimum layout width; otherwise it overlays the canvas and reserves nothing. */
export function resolveLayout({ windowWidth, agentOpen, focusMode }: LayoutInput): ResponsiveChrome {
  const agentShown = agentOpen && !focusMode
  const docks = windowWidth - AGENT_PANEL_WIDTH >= MIN_LAYOUT_WIDTH
  const layoutWidth = windowWidth - (agentShown && docks ? AGENT_PANEL_WIDTH : 0)
  return {
    outlineOverlay: layoutWidth <= OUTLINE_OVERLAY_WIDTH,
    sidebarTight: layoutWidth <= SPLIT_COLLAPSE_WIDTH,
    agentOverlay: agentShown && !docks,
    layoutWidth
  }
}

/** The tokens styles.css keys on (`:root[data-chrome~='…']`). */
export function chromeTokens(layout: ResponsiveChrome): string[] {
  const tokens: string[] = []
  if (layout.outlineOverlay) tokens.push('outline-overlay')
  if (layout.sidebarTight) tokens.push('narrow')
  if (layout.layoutWidth <= STATUS_COMPACT_WIDTH) tokens.push('status-compact')
  if (layout.layoutWidth <= SMALL_WIDTH) tokens.push('small')
  if (layout.agentOverlay) tokens.push('agent-overlay')
  return tokens
}

/* -------------------------------------------------------------- auto-fold */

export type FoldMemory = {
  /** null until the first measurement. */
  lastOutlineTight: boolean | null
  lastSidebarTight: boolean | null
  outlineAutoClosed: boolean
  sidebarAutoClosed: boolean
}

export const newFoldMemory = (): FoldMemory => ({
  lastOutlineTight: null,
  lastSidebarTight: null,
  outlineAutoClosed: false,
  sidebarAutoClosed: false
})

/** Mac `AppModel.widthChanged`. Panels fold away when the layout gets tight
    and come back when there is room — but only if Inkwell folded them. Closing
    a panel by hand is a decision a resize never overrules. Acts only when a
    breakpoint is crossed; mutates `memory` and returns what to set, if
    anything. */
export function foldPanels(
  memory: FoldMemory,
  layout: Pick<ResponsiveChrome, 'outlineOverlay' | 'sidebarTight'>,
  open: { outline: boolean; sidebar: boolean }
): { outline?: boolean; sidebar?: boolean } {
  const change: { outline?: boolean; sidebar?: boolean } = {}

  if (layout.outlineOverlay !== memory.lastOutlineTight) {
    if (layout.outlineOverlay) {
      /* An outline that is open at launch in a tight window was never a
         choice, so it is closed without being remembered. */
      if (open.outline && memory.lastOutlineTight !== null) memory.outlineAutoClosed = true
      if (open.outline) change.outline = false
    } else if (memory.outlineAutoClosed) {
      memory.outlineAutoClosed = false
      if (!open.outline) change.outline = true
    }
    memory.lastOutlineTight = layout.outlineOverlay
  }

  if (layout.sidebarTight !== memory.lastSidebarTight) {
    if (layout.sidebarTight) {
      if (open.sidebar) {
        memory.sidebarAutoClosed = true
        change.sidebar = false
      }
    } else if (memory.sidebarAutoClosed) {
      memory.sidebarAutoClosed = false
      if (!open.sidebar) change.sidebar = true
    }
    memory.lastSidebarTight = layout.sidebarTight
  }

  return change
}

/* ----------------------------------------------------------- header stages */

/** How much the document header shows (Mac `HeaderStage`). When the header
    runs out of room it steps down one stage at a time, most important last:
    the order here is the collapse order, and Save keeps its label longest. */
export const HEADER_STAGES = [
  'full',
  /** Read / Split / Write become icons. */
  'iconViews',
  /** Save drops its Ctrl+S hint. */
  'noShortcutHint',
  /** Save as becomes an icon. */
  'iconSaveAs',
  /** The status line under the title goes, and the title may take two lines. */
  'noSubtitle',
  /** Appearance and Focus move into a ⋯ menu. */
  'overflow',
  /** The document badge goes, the view switcher becomes one menu and Save as
      joins the ⋯ menu. */
  'compact',
  /** Save becomes an icon. */
  'iconSave'
] as const

export type HeaderStage = typeof HEADER_STAGES[number]

export type HeaderStageFlags = {
  viewLabels: boolean
  showsShortcutHint: boolean
  saveAsLabel: boolean
  showsSubtitle: boolean
  usesOverflow: boolean
  isCompact: boolean
  saveLabel: boolean
  /** Width (CSS px) the title keeps before the actions take more. */
  titleReserve: number
}

export function headerStageFlags(stage: HeaderStage): HeaderStageFlags {
  const at = HEADER_STAGES.indexOf(stage)
  const before = (other: HeaderStage) => at < HEADER_STAGES.indexOf(other)
  const showsSubtitle = before('noSubtitle')
  const isCompact = !before('compact')
  return {
    viewLabels: before('iconViews'),
    showsShortcutHint: before('noShortcutHint'),
    saveAsLabel: before('iconSaveAs'),
    showsSubtitle,
    usesOverflow: !before('overflow'),
    isCompact,
    saveLabel: before('iconSave'),
    titleReserve: showsSubtitle ? 200 : isCompact ? 56 : 120
  }
}

/** SwiftUI `ViewThatFits`, as arithmetic: the first stage whose natural width
    fits. `needed[i]` is stage i's measured natural width, or undefined if it
    has not been drawn yet — an unmeasured stage is tried before a later one is
    settled for. The last stage is the fallback. */
export function pickHeaderStage(needed: ReadonlyArray<number | undefined>, available: number): number {
  for (let index = 0; index < HEADER_STAGES.length; index += 1) {
    const width = needed[index]
    if (width === undefined || width <= available + 0.5) return index
  }
  return HEADER_STAGES.length - 1
}

const px = (value: string) => Number.parseFloat(value) || 0

/** The header's natural width at the stage it is currently drawn in: its
    padding, everything that never shrinks, and the room the title reserves.
    The title itself is elastic, so it is counted by its reserve, not its text. */
function naturalHeaderWidth(header: HTMLElement, titleReserve: number): number {
  const style = getComputedStyle(header)
  let total = px(style.paddingLeft) + px(style.paddingRight)
  const blocks = Array.from(header.children) as HTMLElement[]
  total += px(style.columnGap) * Math.max(0, blocks.length - 1)
  for (const block of blocks) {
    if (!block.classList.contains('document-identity')) {
      total += block.getBoundingClientRect().width
      continue
    }
    const parts = Array.from(block.children) as HTMLElement[]
    total += px(getComputedStyle(block).columnGap) * Math.max(0, parts.length - 1)
    for (const part of parts) {
      total += part.classList.contains('identity-text') ? titleReserve : part.getBoundingClientRect().width
    }
  }
  return Math.ceil(total)
}

/** Picks the header stage by measuring, the way `ViewThatFits` does: draw a
    stage, see whether its natural width fits, step down if not. Measuring
    (rather than fixed breakpoints) is what makes this right under zoom, beside
    a docked agent panel, in focus mode and with any label font — the header
    only ever asks "does this row fit the width I actually have".

    `signature` names everything besides the stage that changes which controls
    the row holds (focus mode, say); when it changes the measurements are
    thrown away. Runs in a layout effect, so the intermediate stages are never
    painted. */
export function useHeaderStage(header: RefObject<HTMLElement | null>, signature: string): HeaderStage {
  const [index, setIndex] = useState(0)
  const [fontEpoch, setFontEpoch] = useState(0)
  const cache = useRef<{ key: string; needed: Array<number | undefined> }>({ key: '', needed: [] })

  /* Label widths change when Manrope finishes loading. */
  useEffect(() => {
    let live = true
    void document.fonts?.ready.then(() => { if (live) setFontEpoch((epoch) => epoch + 1) })
    return () => { live = false }
  }, [])

  const key = `${signature}|${fontEpoch}`

  useLayoutEffect(() => {
    const element = header.current
    if (!element) return
    const settle = () => {
      if (cache.current.key !== key) cache.current = { key, needed: [] }
      const flags = headerStageFlags(HEADER_STAGES[index])
      cache.current.needed[index] = naturalHeaderWidth(element, flags.titleReserve)
      const target = pickHeaderStage(cache.current.needed, element.getBoundingClientRect().width)
      if (target !== index) setIndex(target)
    }
    settle()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(settle)
    observer.observe(element)
    return () => observer.disconnect()
  }, [header, key, index])

  return HEADER_STAGES[index]
}

/* -------------------------------------------------------------------- hook */

export function useResponsiveChrome(panels: ChromePanels): ResponsiveChrome {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const { agentOpen, focusMode } = panels

  /* A zoom change resizes the CSS viewport, so it arrives here as a resize
     too — the Mac calls widthChanged on zoom for the same reason. */
  useEffect(() => {
    const sync = () => setWindowWidth(window.innerWidth)
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  const layout = resolveLayout({ windowWidth, agentOpen, focusMode })
  const { outlineOverlay, sidebarTight, agentOverlay, layoutWidth } = layout

  /* Publish the breakpoints for styles.css before the first paint. */
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.chrome = chromeTokens({ outlineOverlay, sidebarTight, agentOverlay, layoutWidth }).join(' ')
    root.style.setProperty('--layout-w', `${layoutWidth}px`)
  }, [outlineOverlay, sidebarTight, agentOverlay, layoutWidth])

  useEffect(() => () => {
    delete document.documentElement.dataset.chrome
    document.documentElement.style.removeProperty('--layout-w')
  }, [])

  /* A tiling compositor (or Snap) hands Inkwell whatever geometry the layout
     dictates, and the width at mount is not the width the user ends up with. */
  const latest = useRef(panels)
  useLayoutEffect(() => { latest.current = panels })
  const memory = useRef<FoldMemory>(newFoldMemory())

  useLayoutEffect(() => {
    const current = latest.current
    const change = foldPanels(memory.current, { outlineOverlay, sidebarTight }, { outline: current.outlineOpen, sidebar: current.sidebarOpen })
    if (change.outline !== undefined) current.setOutlineOpen(change.outline)
    if (change.sidebar !== undefined) current.setSidebarOpen(change.sidebar)
  }, [outlineOverlay, sidebarTight])

  return layout
}
