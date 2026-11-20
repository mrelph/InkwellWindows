import type { AgentPlanItem, AgentToolCall, AgentTranscriptEntry } from '../ipc/contract'
import { asString, isObject, type JsonValue } from './jsonrpc'

/* The chat as the panel shows it, built from `session/update` notifications.
   Pure data, so it is tested without a window. Port of InkwellMac
   AgentTranscript.swift, plus the memory bounds a long session needs. */

/** Oldest entries are dropped past this many. */
export const MAX_ENTRIES = 1000
/** A reply or thought longer than this is cut (a runaway agent must not fill memory). */
export const MAX_TEXT_CHARS = 512 * 1024
/** Text a tool reported, kept for display. */
export const MAX_TOOL_DETAIL_CHARS = 8 * 1024
const MAX_PLAN_ITEMS = 100
const MAX_PATHS = 50
const TRUNCATED = '\n\n[Inkwell cut the rest of this message]'

const cap = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text)

export class AgentTranscript {
  private list: AgentTranscriptEntry[] = []
  private nextId = 0
  private dirty = new Set<number>()
  private truncated = new Set<number>()

  get entries(): readonly AgentTranscriptEntry[] {
    return this.list
  }

  addUser(text: string): number {
    return this.append('user', text)
  }

  addStatus(text: string): number {
    return this.append('status', text)
  }

  addError(text: string): number {
    return this.append('error', text)
  }

  /** Entries changed since the last call, oldest first. */
  drainChanged(): AgentTranscriptEntry[] {
    if (this.dirty.size === 0) return []
    const changed = this.list.filter((entry) => this.dirty.has(entry.id))
    this.dirty.clear()
    return changed
  }

  /** After `session/cancel`: every tool call still open is shown cancelled. */
  markOpenToolsCancelled(): void {
    for (const entry of this.list) {
      if (entry.kind !== 'toolCall' || !entry.tool) continue
      if (entry.tool.status === 'pending' || entry.tool.status === 'in_progress') {
        entry.tool.status = 'cancelled'
        this.dirty.add(entry.id)
      }
    }
  }

  /** Records who refused a tool call: the one with this id, else the latest
      one still open. `fs/*` requests carry no tool call id, so the latest
      open call is the best match. Shortcut: wrong if a harness runs several
      tool calls at once; upgrade when ACP links fs calls to tools. */
  markRefused(toolCallId: string | undefined, by: 'Inkwell' | 'you', reason: string): void {
    const isOpen = (entry: AgentTranscriptEntry) => entry.tool?.status === 'pending' || entry.tool?.status === 'in_progress'
    let index = toolCallId === undefined ? -1 : this.lastIndex((entry) => entry.tool?.toolCallId === toolCallId)
    if (index < 0) index = this.lastIndex(isOpen)
    if (index < 0) return
    const tool = this.list[index].tool
    if (!tool) return
    tool.refusedBy = by
    tool.refusal = reason
    this.dirty.add(this.list[index].id)
  }

  /** The tool call with this id, if the transcript has seen it. */
  toolCall(toolCallId: string | undefined): AgentToolCall | undefined {
    if (toolCallId === undefined) return undefined
    return this.list[this.lastIndex((entry) => entry.tool?.toolCallId === toolCallId)]?.tool
  }

  /** Applies one `params.update` object from `session/update`. Unknown
      variants are ignored, as the spec allows new ones to appear. */
  apply(update: JsonValue | undefined): void {
    if (!isObject(update)) return
    switch (asString(update.sessionUpdate)) {
      case 'agent_message_chunk': this.appendChunk('agentMarkdown', update); break
      case 'agent_thought_chunk': this.appendChunk('thought', update); break
      case 'user_message_chunk': this.appendChunk('user', update); break
      case 'tool_call': this.applyTool(update); break
      case 'tool_call_update': this.applyTool(update); break
      case 'plan': this.applyPlan(update); break
      default: break
    }
  }

  private lastIndex(test: (entry: AgentTranscriptEntry) => boolean): number {
    for (let index = this.list.length - 1; index >= 0; index--) if (test(this.list[index])) return index
    return -1
  }

  private appendChunk(kind: 'agentMarkdown' | 'thought' | 'user', update: Record<string, JsonValue>): void {
    const text = textOf(update.content)
    const messageId = asString(update.messageId)
    const last = this.list[this.list.length - 1]
    if (last && last.kind === kind && (messageId === undefined || last.messageId === undefined || last.messageId === messageId)) {
      if (!this.truncated.has(last.id)) {
        last.text += text
        if (last.text.length > MAX_TEXT_CHARS) {
          last.text = cap(last.text, MAX_TEXT_CHARS) + TRUNCATED
          this.truncated.add(last.id)
        }
      }
      if (last.messageId === undefined && messageId !== undefined) last.messageId = messageId
      this.dirty.add(last.id)
    } else {
      this.append(kind, cap(text, MAX_TEXT_CHARS), { messageId })
    }
  }

  private applyTool(update: Record<string, JsonValue>): void {
    const toolCallId = asString(update.toolCallId)
    if (toolCallId === undefined) return
    const index = this.lastIndex((entry) => entry.tool?.toolCallId === toolCallId)
    const tool: AgentToolCall = index >= 0 && this.list[index].tool
      ? this.list[index].tool
      : { toolCallId, title: 'Tool call', kind: 'other', status: 'pending', detail: '', paths: [] }
    const title = asString(update.title)
    if (title !== undefined) tool.title = cap(title, 500)
    const kind = asString(update.kind)
    if (kind !== undefined) tool.kind = kind
    const status = asString(update.status)
    if (status !== undefined) tool.status = status
    if (Array.isArray(update.content)) {
      // Content on an update replaces the earlier content.
      const texts: string[] = []
      const paths: string[] = []
      for (const item of update.content) {
        if (!isObject(item)) continue
        switch (asString(item.type)) {
          case 'content': texts.push(textOf(item.content)); break
          case 'diff': { const path = asString(item.path); if (path) paths.push(path); break }
          case 'terminal': texts.push('[terminal output]'); break
          default: break
        }
      }
      tool.detail = cap(texts.filter(Boolean).join('\n'), MAX_TOOL_DETAIL_CHARS)
      tool.paths = paths.slice(0, MAX_PATHS)
    }
    if (Array.isArray(update.locations)) {
      for (const location of update.locations) {
        const path = isObject(location) ? asString(location.path) : undefined
        if (path && !tool.paths.includes(path) && tool.paths.length < MAX_PATHS) tool.paths.push(path)
      }
    }
    if (index >= 0) this.dirty.add(this.list[index].id)
    else this.append('toolCall', '', { tool })
  }

  private applyPlan(update: Record<string, JsonValue>): void {
    const plan: AgentPlanItem[] = (Array.isArray(update.entries) ? update.entries : [])
      .slice(0, MAX_PLAN_ITEMS)
      .map((entry) => {
        const item = isObject(entry) ? entry : {}
        return {
          content: cap(asString(item.content) ?? '', 500),
          status: asString(item.status) ?? 'pending',
          priority: asString(item.priority) ?? 'medium'
        }
      })
    // A plan update replaces the whole plan: keep one per prompt turn.
    const lastUser = this.lastIndex((entry) => entry.kind === 'user')
    const existing = this.lastIndex((entry) => entry.kind === 'plan')
    if (existing >= 0 && existing > lastUser) {
      this.list[existing].plan = plan
      this.dirty.add(this.list[existing].id)
    } else {
      this.append('plan', '', { plan })
    }
  }

  private append(
    kind: AgentTranscriptEntry['kind'],
    text: string,
    extra: { messageId?: string; tool?: AgentToolCall; plan?: AgentPlanItem[] } = {}
  ): number {
    const entry: AgentTranscriptEntry = { id: this.nextId++, kind, text }
    if (extra.messageId !== undefined) entry.messageId = extra.messageId
    if (extra.tool) entry.tool = extra.tool
    if (extra.plan) entry.plan = extra.plan
    this.list.push(entry)
    this.dirty.add(entry.id)
    if (this.list.length > MAX_ENTRIES) {
      const dropped = this.list.splice(0, this.list.length - MAX_ENTRIES)
      for (const gone of dropped) {
        this.dirty.delete(gone.id)
        this.truncated.delete(gone.id)
      }
    }
    return entry.id
  }
}

/** Display text for a content block. Only text is shown as such; other kinds
    get a short placeholder, and nothing is fetched. */
export function textOf(block: JsonValue | undefined): string {
  if (!isObject(block)) return ''
  switch (asString(block.type)) {
    case 'text': return asString(block.text) ?? ''
    case 'image': return '[image]'
    case 'audio': return '[audio]'
    case 'resource_link': return `[${asString(block.name) ?? 'resource'}]`
    case 'resource': return `[${(isObject(block.resource) ? asString(block.resource.uri) : undefined) ?? 'resource'}]`
    default: return ''
  }
}
