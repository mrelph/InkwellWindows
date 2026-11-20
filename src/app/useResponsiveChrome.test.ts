import { describe, expect, it } from 'vitest'
import {
  AGENT_PANEL_WIDTH, HEADER_STAGES, chromeTokens, foldPanels, headerStageFlags, newFoldMemory,
  pickHeaderStage, resolveLayout
} from './useResponsiveChrome'

const layoutAt = (windowWidth: number, agentOpen = false, focusMode = false) =>
  resolveLayout({ windowWidth, agentOpen, focusMode })

describe('resolveLayout', () => {
  it('uses the window width when no agent panel is docked', () => {
    expect(layoutAt(1121)).toMatchObject({ outlineOverlay: false, sidebarTight: false, layoutWidth: 1121 })
    expect(layoutAt(1120)).toMatchObject({ outlineOverlay: true, sidebarTight: false })
    expect(layoutAt(820)).toMatchObject({ outlineOverlay: true, sidebarTight: true })
  })

  it('takes a docked agent panel out of the width the breakpoints see', () => {
    const layout = layoutAt(1400, true)
    expect(layout.layoutWidth).toBe(1400 - AGENT_PANEL_WIDTH)
    expect(layout.outlineOverlay).toBe(true)
    expect(layout.agentOverlay).toBe(false)
  })

  it('overlays the agent panel when the document would drop under the minimum', () => {
    const layout = layoutAt(700, true)
    expect(layout.agentOverlay).toBe(true)
    expect(layout.layoutWidth).toBe(700)
  })

  it('ignores the agent panel in focus mode', () => {
    expect(layoutAt(1400, true, true)).toMatchObject({ layoutWidth: 1400, agentOverlay: false, outlineOverlay: false })
  })

  it('publishes one token per crossed breakpoint', () => {
    expect(chromeTokens(layoutAt(1400))).toEqual([])
    expect(chromeTokens(layoutAt(500))).toEqual(['outline-overlay', 'narrow', 'status-compact', 'small'])
    expect(chromeTokens(layoutAt(700, true))).toContain('agent-overlay')
  })
})

describe('foldPanels', () => {
  const wide = { outlineOverlay: false, sidebarTight: false }
  const mid = { outlineOverlay: true, sidebarTight: false }
  const tight = { outlineOverlay: true, sidebarTight: true }

  it('folds both panels when space runs out and restores them when it returns', () => {
    const memory = newFoldMemory()
    expect(foldPanels(memory, wide, { outline: true, sidebar: true })).toEqual({})
    expect(foldPanels(memory, mid, { outline: true, sidebar: true })).toEqual({ outline: false })
    expect(foldPanels(memory, tight, { outline: false, sidebar: true })).toEqual({ sidebar: false })
    expect(foldPanels(memory, mid, { outline: false, sidebar: false })).toEqual({ sidebar: true })
    expect(foldPanels(memory, wide, { outline: false, sidebar: true })).toEqual({ outline: true })
  })

  it('respects a panel the user closed by hand', () => {
    const memory = newFoldMemory()
    foldPanels(memory, wide, { outline: false, sidebar: false })
    expect(foldPanels(memory, tight, { outline: false, sidebar: false })).toEqual({})
    expect(foldPanels(memory, wide, { outline: false, sidebar: false })).toEqual({})
  })

  it('acts only when a breakpoint is crossed', () => {
    const memory = newFoldMemory()
    foldPanels(memory, wide, { outline: true, sidebar: true })
    foldPanels(memory, tight, { outline: true, sidebar: true })
    /* Reopened by hand while tight: staying tight must not close it again. */
    expect(foldPanels(memory, tight, { outline: true, sidebar: true })).toEqual({})
  })

  it('does not remember an outline that was merely open at a tight launch', () => {
    const memory = newFoldMemory()
    expect(foldPanels(memory, mid, { outline: true, sidebar: true })).toEqual({ outline: false })
    expect(foldPanels(memory, wide, { outline: false, sidebar: true })).toEqual({})
  })
})

describe('header stages', () => {
  it('collapses in Mac order, Save keeping its label longest', () => {
    expect(HEADER_STAGES).toEqual(['full', 'iconViews', 'noShortcutHint', 'iconSaveAs', 'noSubtitle', 'overflow', 'compact', 'iconSave'])
    expect(headerStageFlags('full')).toMatchObject({ viewLabels: true, showsShortcutHint: true, saveAsLabel: true, showsSubtitle: true, usesOverflow: false, isCompact: false, saveLabel: true, titleReserve: 200 })
    expect(headerStageFlags('iconViews').viewLabels).toBe(false)
    expect(headerStageFlags('noShortcutHint').showsShortcutHint).toBe(false)
    expect(headerStageFlags('iconSaveAs').saveAsLabel).toBe(false)
    expect(headerStageFlags('noSubtitle')).toMatchObject({ showsSubtitle: false, usesOverflow: false, titleReserve: 120 })
    expect(headerStageFlags('overflow')).toMatchObject({ usesOverflow: true, isCompact: false })
    expect(headerStageFlags('compact')).toMatchObject({ isCompact: true, saveLabel: true, titleReserve: 56 })
    expect(headerStageFlags('iconSave').saveLabel).toBe(false)
  })

  it('picks the first stage that fits, trying unmeasured ones first', () => {
    expect(pickHeaderStage([], 500)).toBe(0)
    expect(pickHeaderStage([900], 500)).toBe(1)
    expect(pickHeaderStage([900, 800, 700, 600, 500, 400, 300, 200], 500)).toBe(4)
    expect(pickHeaderStage([900, 800, 700, 600, 500, 400, 300, 200], 100)).toBe(7)
    expect(pickHeaderStage([900, 800, 700, 600, 500, 400, 300, 200], 2000)).toBe(0)
  })
})
