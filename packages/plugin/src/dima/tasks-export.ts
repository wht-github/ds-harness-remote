import type { DimaTaskRequest, DimaTaskResult } from '@dsh-remote/protocol'
import { invalidReply, record, tooLarge, type NativeRpc } from './native-rpc.js'

const EXPORT_BYTES = 1_048_576
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReply()
  return value
}
function events(value: unknown) {
  if (!Array.isArray(value)) throw invalidReply()
  return value.map(record)
}
function json(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw invalidReply()
    return item
  }, 2)
}
function fence(body: string, language: 'json' | 'text') {
  let longest = 2
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const delimiter = String.fromCharCode(96).repeat(longest + 1)
  return delimiter + language + '\n' + body + '\n' + delimiter
}
function requiredText(value: unknown) {
  if (typeof value !== 'string') throw invalidReply()
  return value
}
/** Concatenate streaming deltas and render only native conversation events. */
function markdown(facts: Record<string, unknown>[]) {
  const chunks: string[] = []
  let delta: { key: string; title: string; text: string } | undefined
  const flush = () => {
    if (delta) chunks.push('### ' + delta.title + '\n\n' + delta.text)
    delta = undefined
  }
  for (const event of facts) {
    if (event.type === 'step' && (event.name === 'text' || event.name === 'thinking')) {
      const data = record(event.data)
      const key = JSON.stringify([event.name, requiredText(data.request_id)])
      if (!delta || delta.key !== key) {
        flush()
        delta = { key, title: event.name === 'text' ? 'Assistant' : 'Reasoning', text: '' }
      }
      delta.text += requiredText(data.delta)
    } else if (event.type === 'input' && event.name === 'message') {
      flush()
      const data = record(event.data)
      if (data.user != null) {
        const paragraphs: string[] = [], hooks: string[] = []
        for (const [index, block] of events(record(data.user).content).entries()) {
          if (block.type === 'text') {
            const value = requiredText(block.text)
            if (index > 0 && /^<dim-hooks(?:\s|>)/.test(value)) hooks.push(value)
            else paragraphs.push(value)
          } else if (block.type === 'image') {
            paragraphs.push('\n[Image attachment: ' + requiredText(record(block.source).mediaType) + ']\n')
          } else paragraphs.push('[' + requiredText(block.type) + ' attachment]')
        }
        chunks.push('### User\n\n' + paragraphs.join(''))
        for (const hook of hooks) chunks.push('### Hook context\n\n' + fence(hook, 'text'))
      }
      for (const block of events(data.blocks ?? [])) chunks.push('### Runtime input\n\n' + fence(requiredText(block.text), 'text'))
    } else if (event.type === 'step' && event.name === 'tool-use') {
      flush()
      const call = record(record(event.data).call)
      chunks.push('### Tool call: ' + requiredText(call.name) + ' (' + requiredText(call.id) + ')\n\n' + fence(json(call.input), 'json'))
    } else if (event.type === 'step' && event.name === 'tool-result') {
      flush()
      for (const result of events(record(event.data).results)) chunks.push('### Tool result: ' + requiredText(result.call_id) + '\n\n' + fence(json(result.result), 'json'))
    } else if (event.type === 'branch' && (event.name === 'create' || event.name === 'create-failed')) {
      flush()
      chunks.push('Child branch ' + requiredText(record(event.data).branch) + (event.name === 'create' ? ' (contents not exported).' : ' was not created.'))
    }
  }
  flush()
  return chunks.join('\n\n')
}
export async function memberPreview(rpc: NativeRpc, sessionId: string, inputEventId: string) {
  const page = record(await rpc.call('session.history', { sessionId, branchId: 'main', latestTurn: true, limit: 128 }))
  const facts = events(page.events)
  if (page.sessionId !== undefined && page.sessionId !== sessionId || page.branchId !== undefined && page.branchId !== 'main') throw invalidReply()
  const index = facts.findIndex(e => e.type === 'input' && e.name === 'message' && e.id === inputEventId)
  // A permanent member can serve another delegation later. Show only the window
  // whose input the leader actually delivered for this request.
  if (index < 0 || facts.slice(index + 1).some(e => e.type === 'input' && e.name === 'message')) return { text: '', truncated: false }
  return { text: markdown(facts.slice(index)), truncated: page.done !== true }
}
/** Match native /export: one immutable main-branch prefix, delivered entirely to the client. */
export async function conversationExport(rpc: NativeRpc, p: DimaTaskRequest<'conversationExport'>, _features: readonly string[]): Promise<DimaTaskResult<'conversationExport'>> {
  if (p.branchId !== 'main') throw invalidReply()
  const facts: Record<string, unknown>[] = []
  let through: number | undefined, after = 0, bytes = 0
  for (let pages = 0; pages < 256; pages++) {
    const page = record(await rpc.call('session.history', { sessionId: p.sessionId, branchId: 'main', after, limit: 128, ...(through !== undefined && { through }) }))
    if (page.sessionId !== undefined && page.sessionId !== p.sessionId || page.branchId !== undefined && page.branchId !== 'main') throw invalidReply()
    const head = number(page.through), next = number(page.nextAfter)
    if (through !== undefined && head !== through || next > head || next < after || typeof page.done !== 'boolean' || (page.done ? next !== head : next <= after)) throw invalidReply()
    let previous = after
    for (const event of events(page.events)) {
      const sequence = number(event.sequence)
      if (sequence <= previous || sequence > next || typeof event.type !== 'string' || typeof event.name !== 'string') throw invalidReply()
      previous = sequence
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (bytes > EXPORT_BYTES || facts.length >= 8192) throw tooLarge()
      facts.push(event)
    }
    through = head; after = next
    if (page.done) {
      const text = p.format === 'json' ? json({ sessionId: p.sessionId, branchId: 'main', through, events: facts }) : '# Session ' + p.sessionId + '\n\nBranch: main\n\n' + markdown(facts) + '\n'
      if (Buffer.byteLength(text) > EXPORT_BYTES) throw tooLarge()
      return { ...p, text }
    }
  }
  throw tooLarge()
}
