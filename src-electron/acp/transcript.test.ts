import { describe, expect, it } from 'vitest'
import { AgentTranscript, MAX_ENTRIES, MAX_TEXT_CHARS, textOf } from './transcript'

const chunk = (kind: string, text: string, messageId?: string) => ({
  sessionUpdate: kind,
  ...(messageId ? { messageId } : {}),
  content: { type: 'text', text }
})

describe('AgentTranscript', () => {
  it('joins chunks and updates tool calls and plans in place', () => {
    const transcript = new AgentTranscript()
    transcript.addUser('hi')
    transcript.apply(chunk('agent_message_chunk', 'Hel', 'm1'))
    transcript.apply(chunk('agent_message_chunk', 'lo', 'm1'))
    transcript.apply(chunk('agent_thought_chunk', 'hmm'))
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' })
    transcript.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'diff', path: '/x.md', newText: 'y' }] })
    transcript.apply({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending', priority: 'high' }] })
    transcript.apply({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }] })
    transcript.apply(chunk('agent_message_chunk', 'Bye', 'm2'))
    transcript.apply({ sessionUpdate: 'something_new' })
    const entries = transcript.entries
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'agentMarkdown', 'thought', 'toolCall', 'plan', 'agentMarkdown'])
    expect(entries[1].text).toBe('Hello')
    expect(entries[3].tool?.status).toBe('completed')
    expect(entries[3].tool?.paths).toEqual(['/x.md'])
    expect(entries[4].plan?.[0].status).toBe('completed')
  })

  it('starts a new message when the message id changes', () => {
    const transcript = new AgentTranscript()
    transcript.apply(chunk('agent_message_chunk', 'one', 'm1'))
    transcript.apply(chunk('agent_message_chunk', 'two', 'm2'))
    expect(transcript.entries.map((entry) => entry.text)).toEqual(['one', 'two'])
  })

  it('keeps one plan per turn', () => {
    const transcript = new AgentTranscript()
    transcript.apply({ sessionUpdate: 'plan', entries: [{ content: 'a' }] })
    transcript.addUser('next turn')
    transcript.apply({ sessionUpdate: 'plan', entries: [{ content: 'b' }] })
    expect(transcript.entries.filter((entry) => entry.kind === 'plan')).toHaveLength(2)
    expect(transcript.entries[0].plan?.[0]).toEqual({ content: 'a', status: 'pending', priority: 'medium' })
  })

  it('marks open tool calls cancelled', () => {
    const transcript = new AgentTranscript()
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'A', status: 'in_progress' })
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'B', status: 'completed' })
    transcript.markOpenToolsCancelled()
    expect(transcript.entries.map((entry) => entry.tool?.status)).toEqual(['cancelled', 'completed'])
  })

  it('records who refused a tool call: by id, else the latest open one', () => {
    const transcript = new AgentTranscript()
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read', status: 'completed' })
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Write File', status: 'in_progress' })
    transcript.markRefused(undefined, 'Inkwell', 'outside')
    expect(transcript.entries.map((entry) => entry.tool?.refusedBy)).toEqual([undefined, 'Inkwell'])
    transcript.markRefused('a', 'you', 'Deny')
    expect(transcript.entries[0].tool?.refusedBy).toBe('you')
  })

  it('reports each changed entry once', () => {
    const transcript = new AgentTranscript()
    transcript.apply(chunk('agent_message_chunk', 'a', 'm'))
    transcript.apply(chunk('agent_message_chunk', 'b', 'm'))
    expect(transcript.drainChanged().map((entry) => entry.text)).toEqual(['ab'])
    expect(transcript.drainChanged()).toEqual([])
  })

  it('bounds entries and the size of a runaway reply', () => {
    const transcript = new AgentTranscript()
    for (let i = 0; i < MAX_ENTRIES + 25; i++) transcript.addStatus(`s${i}`)
    expect(transcript.entries).toHaveLength(MAX_ENTRIES)
    expect(transcript.entries[0].text).toBe('s25')

    const reply = new AgentTranscript()
    const block = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) reply.apply(chunk('agent_message_chunk', block, 'm'))
    const stored = reply.entries[0].text
    expect(stored.length).toBeLessThan(MAX_TEXT_CHARS + 100)
    expect(stored.endsWith('cut the rest of this message]')).toBe(true)
  })

  it('shows placeholders, never content, for non-text blocks', () => {
    expect(textOf({ type: 'image', data: 'AAAA' })).toBe('[image]')
    expect(textOf({ type: 'resource_link', name: 'spec' })).toBe('[spec]')
    expect(textOf({ type: 'resource', resource: { uri: 'file:///a.md', text: 'secret' } })).toBe('[file:///a.md]')
  })
})
