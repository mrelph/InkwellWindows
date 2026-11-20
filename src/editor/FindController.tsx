import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react'
import { useCommand } from '../app/commands'
import type { EditorHandle, FindMode } from './Editor'
import { setFindActions, subscribeFindContent } from './findBridge'
import { findMatches, matchIndexAt, matchIndexFrom, replaceAllEdit, type FindMatch } from './findLogic'
import { clearReaderMatches, collectReaderMatches, paintReaderMatches, revealReaderMatch } from './readerFind'
import './FindController.css'

/* Always mounted by App, whatever the view. Owns the find / find-and-replace
   bar and the find command family. With the editor on screen the bar searches
   the Markdown source and selects each match in the textarea; in Read view it
   searches the rendered text instead (DOM matches painted with the CSS Custom
   Highlight API, since the IPC contract has no findInPage channel). */

export type FindControllerProps = {
  /** The editor, when it is mounted (split and write views). */
  editor: RefObject<EditorHandle | null>
  view: ViewMode
}

type Move = 'initial' | 'next' | 'previous' | 'refresh'

export function FindController({ editor, view }: FindControllerProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<FindMode>('find')
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [stats, setStats] = useState({ total: 0, current: -1 })
  const findInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const readerRanges = useRef<Range[]>([])
  const readerCurrent = useRef(-1)

  /* The editor is the target while it is on screen; otherwise the reader. */
  const editorTarget = useCallback((): EditorHandle | null => {
    const handle = editor.current
    return view !== 'read' && handle?.isVisible() ? handle : null
  }, [editor, view])

  const search = useCallback((move: Move) => {
    if (!query) {
      readerRanges.current = []
      readerCurrent.current = -1
      clearReaderMatches()
      setStats({ total: 0, current: -1 })
      return
    }
    const target = editorTarget()
    if (target) {
      clearReaderMatches()
      const matches: FindMatch[] = findMatches(target.getText(), query, caseSensitive)
      if (!matches.length) { setStats({ total: 0, current: -1 }); return }
      const selection = target.getSelection()
      let index = matchIndexAt(matches, selection.start, selection.end)
      if (move === 'initial') index = matchIndexFrom(matches, selection.start, 'forward')
      else if (move === 'next') index = matchIndexFrom(matches, selection.end, 'forward')
      else if (move === 'previous') index = matchIndexFrom(matches, selection.start, 'backward')
      if (move !== 'refresh' && index >= 0) target.selectRange(matches[index].start, matches[index].end)
      setStats({ total: matches.length, current: index })
      return
    }
    const root = document.querySelector('.reader-panel')
    if (!root) { setStats({ total: 0, current: -1 }); return }
    const ranges = collectReaderMatches(root, query, caseSensitive)
    readerRanges.current = ranges
    if (!ranges.length) {
      readerCurrent.current = -1
      clearReaderMatches()
      setStats({ total: 0, current: -1 })
      return
    }
    let index = readerCurrent.current
    if (move === 'initial') index = 0
    else if (move === 'next') index = (index + 1) % ranges.length
    else if (move === 'previous') index = (index - 1 + ranges.length) % ranges.length
    index = Math.min(Math.max(index, 0), ranges.length - 1)
    readerCurrent.current = index
    paintReaderMatches(ranges, index)
    if (move !== 'refresh') revealReaderMatch(ranges[index])
    setStats({ total: ranges.length, current: index })
  }, [query, caseSensitive, editorTarget])

  /* Always call the newest search from long-lived callbacks. */
  const latestSearch = useRef(search)
  latestSearch.current = search

  /* Incremental: re-search from the caret as the query or case option changes. */
  useEffect(() => {
    if (open) search('initial')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on query/case/open/view only
  }, [open, query, caseSensitive, view])

  /* Keep the count and highlights right while the text changes underneath. */
  useEffect(() => {
    if (!open) return
    const unsubscribe = subscribeFindContent(() => latestSearch.current('refresh'))
    const root = document.querySelector('.reader-panel')
    let frame = 0
    const observer = root ? new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => latestSearch.current('refresh'))
    }) : null
    if (root && observer) observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { unsubscribe(); observer?.disconnect(); cancelAnimationFrame(frame) }
  }, [open, view])

  useEffect(() => { if (!open) clearReaderMatches() }, [open])
  useEffect(() => clearReaderMatches, [])

  const focusFind = () => requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select() })

  const openBar = (next: FindMode) => {
    /* Seed the query from a single-line selection, as Mac's find bar does. */
    const picked = pickedSelection()
    if (picked && picked !== query) setQuery(picked)
    setMode(next)
    setOpen(true)
    if (next === 'replace' && (picked || query)) requestAnimationFrame(() => replaceInput.current?.focus())
    else focusFind()
  }

  const pickedSelection = (): string => {
    const target = editorTarget()
    const text = target ? target.getSelection().text : window.getSelection()?.toString() ?? ''
    return text && !text.includes('\n') && text.length <= 200 ? text : ''
  }

  const close = () => {
    setOpen(false)
    const target = editorTarget()
    if (target) target.focus()
  }

  const step = (direction: 'next' | 'previous') => {
    if (!open) { setOpen(true); focusFind(); return }
    search(direction)
  }

  const useSelection = () => {
    const picked = pickedSelection()
    if (picked) setQuery(picked)
    setOpen(true)
    focusFind()
  }

  /* Replace the selected match (when the selection is one), then move on. */
  const replaceCurrent = () => {
    const target = editorTarget()
    if (!target || !query) return
    const selection = target.getSelection()
    const matches = findMatches(target.getText(), query, caseSensitive)
    if (matchIndexAt(matches, selection.start, selection.end) >= 0) {
      target.replaceRange(selection.start, selection.end, replacement)
    }
    search('next')
  }

  /* Replace all is a single edit, so one Ctrl+Z undoes the lot. */
  const replaceEvery = () => {
    const target = editorTarget()
    if (!target || !query) return
    const text = target.getText()
    const edit = replaceAllEdit(text, findMatches(text, query, caseSensitive), replacement)
    if (!edit) return
    target.replaceRange(edit.start, edit.end, edit.text)
    search('refresh')
  }

  const actions = useRef({ open: openBar, next: () => step('next'), previous: () => step('previous'), useSelection })
  actions.current = { open: openBar, next: () => step('next'), previous: () => step('previous'), useSelection }
  useEffect(() => {
    setFindActions({
      open: (next) => actions.current.open(next),
      next: () => actions.current.next(),
      previous: () => actions.current.previous(),
      useSelection: () => actions.current.useSelection()
    })
    return () => setFindActions(null)
  }, [])

  useCommand('find', () => openBar('find'))
  useCommand('replace', () => openBar('replace'))
  useCommand('findNext', () => step('next'))
  useCommand('findPrevious', () => step('previous'))
  useCommand('useSelectionForFind', useSelection)
  /* While the bar is up, Escape closes it before it dismisses anything else. */
  useCommand('escape', close, open)

  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? 'previous' : 'next') }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }
  const onReplaceKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); replaceCurrent() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }

  if (!open) return null

  const canReplace = Boolean(editorTarget())
  const showReplace = mode === 'replace' && canReplace
  const label = !query ? '' : stats.total === 0 ? 'No matches' : `${stats.current >= 0 ? stats.current + 1 : '–'} of ${stats.total}`

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <div className="find-row">
        {canReplace && (
          <button
            type="button"
            className={`find-button find-toggle${showReplace ? ' is-open' : ''}`}
            aria-label={showReplace ? 'Hide replace' : 'Show replace'}
            aria-expanded={showReplace}
            title="Toggle replace"
            onClick={() => { setMode(showReplace ? 'find' : 'replace') }}
          >
            <ChevronRight size={14} />
          </button>
        )}
        <input
          ref={findInput}
          className="find-input"
          value={query}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onFindKey}
        />
        <span className="find-count" aria-live="polite">{label}</span>
        <button
          type="button"
          className={`find-button${caseSensitive ? ' is-active' : ''}`}
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setCaseSensitive((on) => !on)}
        >
          <CaseSensitive size={16} />
        </button>
        <button type="button" className="find-button" aria-label="Previous match" title="Previous (Shift+F3)" disabled={!stats.total} onClick={() => step('previous')}>
          <ChevronUp size={15} />
        </button>
        <button type="button" className="find-button" aria-label="Next match" title="Next (F3)" disabled={!stats.total} onClick={() => step('next')}>
          <ChevronDown size={15} />
        </button>
        <button type="button" className="find-button" aria-label="Close find" title="Close (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </div>
      {showReplace && (
        <div className="find-row">
          <input
            ref={replaceInput}
            className="find-input"
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            spellCheck={false}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={onReplaceKey}
          />
          <button type="button" className="find-text-button" disabled={!stats.total} onClick={replaceCurrent}>Replace</button>
          <button type="button" className="find-text-button" disabled={!stats.total} onClick={replaceEvery}>Replace All</button>
        </div>
      )}
    </div>
  )
}
