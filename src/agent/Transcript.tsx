import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, ArrowRightLeft, Brain, CheckCircle2, Circle, CircleDot, FileText, Globe,
  ListChecks, Pencil, Search, Terminal, Trash2, Wrench
} from 'lucide-react'
import type { AgentToolCall, AgentTranscriptEntry } from '../../src-electron/ipc/contract'
import { reveal, webUrl } from './reveal'

/* The streamed chat. Agent text is untrusted: it is rendered as Markdown with
   the reader's typography (.markdown-prose) but never loads an image, never
   renders raw HTML, and a link carries no href at all (so a middle click or a
   drag cannot navigate) — a click asks the panel to confirm the full URL. */

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function markdownComponents(onLink: (url: string) => void): Components {
  return {
    a: ({ href, children }) => {
      const url = webUrl(href)
      if (!url) return <span className="agent-link blocked" title="Inkwell only opens web links from the agent">{children}</span>
      return (
        <button type="button" className="agent-link" title={reveal(url)} onClick={() => onLink(url)}>
          {children}
        </button>
      )
    },
    img: ({ alt }) => <span className="agent-image-note">[image{alt ? `: ${reveal(alt)}` : ''} not loaded]</span>,
    // Headings must not claim ids: they would collide with the open note's anchors.
    h1: ({ children }) => <h3>{children}</h3>,
    h2: ({ children }) => <h3>{children}</h3>,
    h3: ({ children }) => <h4>{children}</h4>,
    h4: ({ children }) => <h5>{children}</h5>,
    h5: ({ children }) => <h5>{children}</h5>,
    h6: ({ children }) => <h5>{children}</h5>,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly />,
    code: ({ children, className }) => <code className={className}>{textOf(children)}</code>
  }
}

const AgentMarkdown = memo(function AgentMarkdown({ text, onLink }: { text: string; onLink: (url: string) => void }) {
  const components = useMemo(() => markdownComponents(onLink), [onLink])
  return (
    <div className="markdown-prose agent-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {reveal(text)}
      </ReactMarkdown>
    </div>
  )
})

const toolIcon = (kind: string) => {
  switch (kind) {
    case 'read': return <FileText size={13} />
    case 'edit': return <Pencil size={13} />
    case 'delete': return <Trash2 size={13} />
    case 'move': return <ArrowRightLeft size={13} />
    case 'search': return <Search size={13} />
    case 'execute': return <Terminal size={13} />
    case 'think': return <Brain size={13} />
    case 'fetch': return <Globe size={13} />
    default: return <Wrench size={13} />
  }
}

/** What stopped a call: Inkwell's sandbox, the user, or the harness itself. */
export function refusalLine(tool: AgentToolCall, harness: string): string {
  if (tool.refusedBy === 'Inkwell') return `Blocked by Inkwell: ${tool.refusal ?? ''}`
  if (tool.refusedBy === 'you') return tool.refusal ? `Denied: ${tool.refusal}` : 'Denied by you'
  return `Failed in ${harness}, not blocked by Inkwell`
}

export function statusLabel(tool: AgentToolCall): string {
  switch (tool.status) {
    case 'pending': return 'Pending'
    case 'in_progress': return 'Running'
    case 'completed': return 'Done'
    case 'failed': return tool.refusedBy === 'Inkwell' ? 'Blocked' : tool.refusedBy === 'you' ? 'Denied' : 'Failed'
    case 'cancelled': return 'Cancelled'
    default: return tool.status.replace(/_/g, ' ')
  }
}

function ToolCall({ tool, harness }: { tool: AgentToolCall; harness: string }) {
  const failed = tool.status === 'failed' || tool.refusedBy !== undefined
  return (
    <div className="agent-tool" data-status={tool.status}>
      <div className="agent-tool-head">
        <span className="agent-tool-icon" aria-hidden="true">{toolIcon(tool.kind)}</span>
        <span className="agent-tool-title">{reveal(tool.title)}</span>
        <span className={`agent-chip ${tool.status}${tool.refusedBy ? ' refused' : ''}`}>{statusLabel(tool)}</span>
      </div>
      {tool.paths.map((path) => (
        <div key={path} className="agent-tool-path" title={reveal(path)}>{reveal(path)}</div>
      ))}
      {failed && <div className="agent-tool-refusal">{reveal(refusalLine(tool, harness))}</div>}
      {tool.detail && <pre className="agent-tool-detail">{reveal(tool.detail.slice(0, 600))}</pre>}
    </div>
  )
}

function PlanIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 size={13} className="done" />
  if (status === 'in_progress') return <CircleDot size={13} />
  return <Circle size={13} />
}

export type EntryViewProps = {
  entry: AgentTranscriptEntry
  harness: string
  onLink: (url: string) => void
}

export const EntryView = memo(function EntryView({ entry, harness, onLink }: EntryViewProps) {
  switch (entry.kind) {
    case 'user':
      return <div className="agent-entry user">{reveal(entry.text)}</div>
    case 'agentMarkdown':
      return <AgentMarkdown text={entry.text} onLink={onLink} />
    case 'thought':
      return (
        <details className="agent-thought">
          <summary><Brain size={12} aria-hidden="true" /> Thought</summary>
          <p>{reveal(entry.text)}</p>
        </details>
      )
    case 'toolCall':
      return entry.tool ? <ToolCall tool={entry.tool} harness={harness} /> : null
    case 'plan':
      return (
        <div className="agent-plan">
          <div className="agent-plan-title"><ListChecks size={13} aria-hidden="true" /> Plan</div>
          <ul>
            {(entry.plan ?? []).map((item, index) => (
              <li key={index} className={item.status}>
                <PlanIcon status={item.status} />
                <span>{reveal(item.content)}</span>
              </li>
            ))}
          </ul>
        </div>
      )
    case 'status':
      return <div className="agent-entry status">{reveal(entry.text)}</div>
    case 'error':
      return (
        <div className="agent-entry error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> <span>{reveal(entry.text)}</span>
        </div>
      )
  }
})
