import type { RefObject } from 'react'
import { ChevronDown, Ellipsis, FilePlus2, FileText, FolderPlus, History, RefreshCw, Search, X } from 'lucide-react'
import type { FolderSource, LibraryGroup, LibraryRow } from '../lib/library'
import { clampTitle } from '../lib/paths'

/* The library pane. Presentational: every action is a prop from App. */

export type SidebarProps = {
  groups: LibraryGroup[]
  activeId: string | null
  restored: boolean
  query: string
  onQuery: (query: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  isOpenGroup: (group: LibraryGroup) => boolean
  onToggleGroup: (id: string) => void
  /** The active row, and whether it can be closed (drafts, recent, Ephy). */
  activeRow: LibraryRow | null
  closableRow: LibraryRow | null
  onNewNote: () => void
  onOpen: () => void
  onAddFolder: () => void
  onCloseRow: (row: LibraryRow) => void
  onOpenRow: (row: LibraryRow) => void
  onRefreshFolder: (source: FolderSource) => void
  onRemoveFolder: (source: FolderSource) => void
  onRowMenu: (row: LibraryRow, x: number, y: number) => void
  renamingKey: string | null
  renameDraft: string
  onRenameDraft: (draft: string) => void
  onRenameCommit: (row: LibraryRow) => void
  /** Escape in the rename field. */
  onRenameCancel: () => void
}

export function Sidebar(props: SidebarProps) {
  const { groups, activeId, restored, query, activeRow, closableRow } = props
  const rowCount = groups.reduce((total, group) => total + group.rows.length, 0)

  return (
    <aside className="sidebar" aria-label="Library">
      <div className="sidebar-actions">
        <button className="new-note" title="New note (Ctrl+N)" onClick={props.onNewNote}><FilePlus2 size={16} strokeWidth={1.8} /> New note</button>
        <button className="icon-button" aria-label="Open Markdown file" title="Open a file — adds it to Recent (Ctrl+O)" onClick={props.onOpen}><FileText size={18} strokeWidth={1.7} /></button>
        <button className="icon-button" aria-label="Add folder to the library" title="Add a folder — keeps its Markdown in the library (Ctrl+Shift+O)" onClick={props.onAddFolder}><FolderPlus size={18} strokeWidth={1.7} /></button>
        <button
          className="icon-button"
          aria-label={closableRow ? `Close ${closableRow.name}` : 'Close the current document'}
          title={closableRow
            ? `Close ${closableRow.name} (Ctrl+W)`
            : activeRow
              ? 'A file in an added folder stays in the library — remove the folder instead, or move the file to the trash'
              : 'Nothing open to close'}
          disabled={!closableRow}
          onClick={() => { if (closableRow) props.onCloseRow(closableRow) }}
        >
          <X size={18} strokeWidth={1.7} />
        </button>
      </div>

      <label className="search-box">
        <Search size={16} strokeWidth={1.7} />
        <input
          ref={props.searchRef}
          value={query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Find in documents"
          aria-label="Find in documents"
          title="Find in documents (Ctrl+Shift+L)"
        />
        {query && <button className="clear-search" onClick={() => props.onQuery('')} aria-label="Clear search"><X size={14} /></button>}
      </label>

      <div className="library-scroll">
        {groups.map((group) => (
          <section className="library-group" key={group.id}>
            <div className="library-label">
              <button
                className="folder-line"
                aria-expanded={props.isOpenGroup(group)}
                aria-controls={`group-${group.id}`}
                title={group.path ?? group.name}
                onClick={() => props.onToggleGroup(group.id)}
              >
                <ChevronDown size={14} />
                {group.kind === 'recent' && <History size={12} strokeWidth={1.9} />}
                <span>{group.name}</span>
              </button>
              <span className="group-count">{group.rows.length}</span>
              {group.kind === 'folder' && (
                <>
                  <button
                    className="group-action"
                    aria-label={`Refresh ${group.name}`}
                    title="Re-read this folder from disk"
                    onClick={() => props.onRefreshFolder({ id: group.id, name: group.name, path: group.path ?? '' })}
                  >
                    <RefreshCw size={12} strokeWidth={2} />
                  </button>
                  <button
                    className="group-action"
                    aria-label={`Remove ${group.name} from the library`}
                    title="Remove this folder from the library — the files stay on disk"
                    onClick={() => props.onRemoveFolder({ id: group.id, name: group.name, path: group.path ?? '' })}
                  >
                    <X size={13} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>

            {props.isOpenGroup(group) && (
              <div className="document-list" id={`group-${group.id}`}>
                {group.rows.length ? group.rows.map((row) => (
                  <div
                    className={`document-row ${row.doc ? '' : 'unopened'}`}
                    key={row.key}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      props.onRowMenu(row, event.clientX, event.clientY)
                    }}
                  >
                    {props.renamingKey === row.key ? (
                      <form
                        className="rename-form"
                        onSubmit={(event) => { event.preventDefault(); props.onRenameCommit(row) }}
                      >
                        <input
                          autoFocus
                          value={props.renameDraft}
                          aria-label={`Rename ${clampTitle(row.name)}`}
                          onChange={(event) => props.onRenameDraft(event.target.value)}
                          onBlur={() => props.onRenameCommit(row)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape') return
                            event.stopPropagation()
                            props.onRenameCancel()
                          }}
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          className={`document-item ${row.doc && row.doc.id === activeId ? 'active' : ''}`}
                          aria-current={Boolean(row.doc && row.doc.id === activeId)}
                          title={row.path ?? (row.kind === 'ephy' ? 'Ephy note — not a file on disk' : 'Unsaved draft — not yet on disk')}
                          onClick={() => props.onOpenRow(row)}
                        >
                          <FileText size={16} strokeWidth={1.6} />
                          <span>
                            <strong>{clampTitle(row.name)}</strong>
                            <small>
                              {row.doc?.isDirty && <span className="dirty-mark" aria-label="Unsaved changes">• </span>}
                              {row.meta}
                            </small>
                          </span>
                        </button>
                        <button
                          className="row-menu-button"
                          aria-haspopup="menu"
                          aria-label={`Actions for ${clampTitle(row.name)}`}
                          title="Actions"
                          onClick={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect()
                            props.onRowMenu(row, bounds.left, bounds.bottom + 4)
                          }}
                        >
                          <Ellipsis size={14} />
                        </button>
                      </>
                    )}
                  </div>
                )) : (
                  <p className="empty-library">No Markdown files in this folder.</p>
                )}
              </div>
            )}
          </section>
        ))}

        {!rowCount && (
          <p className="empty-library">
            {!restored
              ? 'Reading your library…'
              : query
                ? `Nothing matches “${query}”.`
                : 'Nothing here yet. Add a folder with Ctrl+Shift+O, open a file with Ctrl+O, or start a note with Ctrl+N.'}
          </p>
        )}
      </div>
    </aside>
  )
}
