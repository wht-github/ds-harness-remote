import type { DimaTimelineBlock, DimaTimelineTurn } from '@dsh-remote/protocol'
import { invalidReply, record, tooLarge } from './native-rpc.js'

export function timelineId(v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > 512 || v.includes('\0')) throw invalidReply()
  return v
}
export function position(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalidReply()
  return v
}
export function records(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw invalidReply()
  return v.map(record)
}
function string(v: unknown): string {
  if (typeof v !== 'string') throw invalidReply()
  return v
}
function content(value: unknown, user = false): string {
  if (typeof value === 'string') return value
  return records(value).map((block, index) => {
    if (block.type === 'image') return '[image]'
    if (block.type !== 'text') return ''
    const text = string(block.text)
    return user && index > 0 && /^<dim-(?:skill|hooks)(?:>|\s)/.test(text) ? '' : text
  }).filter(Boolean).join('\n')
}
function fileAttachments(value: unknown, block: DimaTimelineBlock) {
  if (!Array.isArray(value)) return
  const files: NonNullable<DimaTimelineBlock['attachments']> = []
  for (const item of records(value)) {
    if (item.type !== 'image' || item.source == null) continue
    const source = record(item.source)
    if (source.type !== 'file' || typeof source.mediaType !== 'string' || !source.mediaType.length || source.mediaType.length > 128) continue
    if (files.length >= 64) { block.truncated = true; break }
    files.push({ fileId: timelineId(source.fileId), mediaType: source.mediaType })
  }
  if (files.length) block.attachments = files
}
function clipped(value: string, length: number) {
  let end = Math.max(0, length)
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
  return value.slice(0, end)
}

/** One bounded, ascending branch window and its transient model snapshot. */
export function projectTimeline(events: Record<string, unknown>[], progress: Record<string, unknown> | undefined, through: number, maxChars = 65536) {
  function assignText(block: DimaTimelineBlock, key: 'text' | 'output' | 'input' | 'diff', value: string) {
    const shown = clipped(value, maxChars)
    block[key] = shown
    if (shown.length < value.length) block.truncated = true
  }
  const turns = new Map<string, DimaTimelineTurn>()
  const inputs = new Map<string, DimaTimelineBlock>()
  const inputTurns = new Map<string, string>()
  const waiting: Array<{inputId: string; sequence: number}> = []
  const deletedInputs = new Set<string>()
  const tools = new Map<string, DimaTimelineBlock>()
  const open = new Map<string, DimaTimelineBlock>()
  const ended = new Set<string>()
  const committed = new Map<string, { text: number; thinking: number }>()
  let activeTurn: string | undefined
  let count = 0
  function turn(id: string, seq: number) {
    let row = turns.get(id)
    if (!row) { row = { id, sequence: seq, blocks: [] }; turns.set(id, row) }
    if (seq < row.sequence) row.sequence = seq
    return row
  }
  function add(row: DimaTimelineTurn, block: DimaTimelineBlock) {
    if (++count > 256) throw tooLarge()
    row.blocks.push(block)
    return block
  }
  function tool(row: DimaTimelineTurn, requestId: string, callId: unknown, seq: number) {
    const id = JSON.stringify([requestId, timelineId(callId)])
    let block = tools.get(id)
    if (!block) {
      block = add(row, { id, requestId, sequence: seq, text: '', kind: 'tool' })
      tools.set(id, block)
    }
    return block
  }
  for (const event of events) {
    if (event.parent_call_id != null) continue
    const id = timelineId(event.id), seq = position(event.sequence)
    const key = string(event.type) + '/' + string(event.name)
    if (event.type !== 'input' && event.type !== 'turn' && event.type !== 'step' && key !== 'model/usage') continue
    const data = record(event.data)
    if (key === 'input/message' && data.user != null) {
      const text = content(record(data.user).content, true)
      if (text) {
        const block: DimaTimelineBlock = { id, sequence: seq, text: '', kind: 'user' }
        fileAttachments(record(data.user).content, block)
        assignText(block, 'text', text)
        inputs.set(id, block)
      }
    }
    if (key === 'input/consumed') {
      const inputId = timelineId(data.input_id)
      if (activeTurn) inputTurns.set(inputId, activeTurn)
      else waiting.push({ inputId, sequence: seq })
    }
    if (key === 'input/deleted') {
      const inputId = timelineId(data.input_id)
      deletedInputs.add(inputId)
      inputs.delete(inputId)
    }
    if ((event.type !== 'turn' && event.type !== 'step' && key !== 'model/usage') || data.turn_id == null) continue
    const turnId = timelineId(data.turn_id)
    activeTurn = turnId
    for (const pending of waiting.splice(0)) inputTurns.set(pending.inputId, turnId)
    const row = turn(turnId, seq)
    row.lastEvent = seq
    if (key === 'turn/start') {
      row.status = 'running'
      if (event.create_at !== undefined) row.startedAt = position(event.create_at)
      continue
    }
    if (key === 'turn/end') {
      if (data.status !== 'completed' && data.status !== 'failed' && data.status !== 'cancelled') throw invalidReply()
      row.status = data.status
      if (event.create_at !== undefined) row.endedAt = position(event.create_at)
      const detail = data.status === 'failed' ? data.error : data.reason
      if (data.status !== 'completed' && typeof detail === 'string') row.detail = clipped(detail, 2048)
      activeTurn = undefined
      continue
    }
    if (data.request_id == null) continue
    const requestId = timelineId(data.request_id)
    if (key === 'model/usage') {
      const usage = record(data.usage)
      function tokens(key: string) {
        const n = usage[key]
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw invalidReply()
        return n
      }
      const entry: NonNullable<DimaTimelineTurn['usage']>[number] = { requestId, promptTokens: tokens('promptTokens'),
        completionTokens: tokens('completionTokens'), totalTokens: tokens('totalTokens') }
      for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) if (usage[key] != null) entry[key] = tokens(key)
      if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) entry.cost = usage.cost
      if (typeof usage.currency === 'string') entry.currency = clipped(usage.currency, 32)
      row.usage = [...(row.usage ?? []).filter(old => old.requestId !== requestId), entry]
    } else if (key === 'step/text' || key === 'step/thinking') {
      const kind = key === 'step/text' ? 'text' : 'thinking'
      const delta = string(data.delta)
      if (!delta.length) continue
      let block = open.get(requestId)
      if (block?.kind !== kind || block.text.length + delta.length > maxChars || block.parts!.length >= 4096) {
        block = add(row, { kind, id, sequence: seq, requestId, text: '', parts: [] })
        open.set(requestId, block)
      }
      const piece = clipped(delta, maxChars - block.text.length)
      block.text += piece
      block.parts!.push({ id, sequence: seq, length: piece.length })
      if (piece.length < delta.length) block.truncated = true
      const chars = committed.get(requestId) ?? { text: 0, thinking: 0 }
      for (const _char of delta) chars[kind]++
      committed.set(requestId, chars)
    } else if (key === 'step/model-output-end') { open.delete(requestId); ended.add(requestId) }
    else if (key.startsWith('step/tool-')) {
      open.delete(requestId)
      if (key === 'step/tool-use-start' || key === 'step/tool-start') {
        const block = tool(row, requestId, data.call_id, seq)
        if (data.name != null) block.tool = timelineId(data.name)
        block.state ??= 'running'
      } else if (key === 'step/tool-use' || key === 'step/tool-call') {
        for (const call of key === 'step/tool-use' ? [record(data.call)] : records(data.calls)) {
          const block = tool(row, requestId, call.id, seq)
          block.tool = timelineId(call.name)
          assignText(block, 'input', JSON.stringify(record(call.input)))
          block.state ??= 'running'
        }
      } else if (key === 'step/tool-completed' || key === 'step/tool-result') {
        for (const item of key === 'step/tool-completed' ? [data] : records(data.results)) {
          const block = tool(row, requestId, item.call_id, seq), result = record(item.result)
          fileAttachments(result.content, block)
          assignText(block, 'output', content(result.content))
          if (result.structuredContent != null) {
            const diff = record(result.structuredContent).diff
            if (typeof diff === 'string') assignText(block, 'diff', diff)
          }
          block.state = result.isError === true ? 'failed' : 'completed'
        }
      }
    }
  }
  for (const [id, block] of inputs) add(turn(inputTurns.get(id) ?? 'input:' + id, block.sequence), block)
  if (progress?.turnId != null && progress.requestId != null) {
    const turnId = timelineId(progress.turnId), requestId = timelineId(progress.requestId)
    const row = turn(turnId, through + 1)
    if (!ended.has(requestId) && (!row.status || row.status === 'running')) {
      row.status = 'running'
      for (const kind of ['thinking', 'text'] as const) {
        const value = string(progress[kind])
        if (!value) continue
        const rawId = progress[kind + 'PartId']
        const id = rawId == null ? 'live:' + kind + ':' + requestId : timelineId(rawId)
        const offset = position(progress[kind + 'Offset'])
        const written = committed.get(requestId)?.[kind] ?? 0
        const known = row.blocks.find(b => b.kind === kind && (b.id === id || b.parts?.some(part => part.id === id)))
        // Offsets are Unicode scalar counts across the request, not JS string offsets.
        let skip = known ? Math.max(0, written - offset) : 0
        let start = 0
        for (const c of value) { if (skip-- <= 0) break; start += c.length }
        if (start === value.length) continue
        const last = open.get(requestId)
        const continuation = last?.kind === kind && (known || offset > 0) ? last : known
        const block = continuation ?? add(row, { kind, id, sequence: through + 1, text: '', requestId, live: true, liveOffset: offset })
        const suffix = clipped(value.slice(start), maxChars - block.text.length)
        block.text += suffix
        if (suffix.length !== value.length - start) block.truncated = true
      }
      for (const item of records(progress.tools)) {
        const block = tool(row, requestId, item.callId, through + 1)
        if (block.sequence > through) block.live = true
        if (block.input === undefined && (!block.state || block.state === 'running')) {
          if (item.name) block.tool = timelineId(item.name)
          block.state = 'running'
          block.liveInput = true
          assignText(block, 'input', string(item.arguments))
        }
      }
    }
  }
  const rows = [...turns.values()].filter(t => t.blocks.length || t.status || t.usage?.length)
  for (const row of rows) row.blocks.sort((a, b) => a.sequence - b.sequence)
  return { pendingConsumes: waiting, deletedInputs: [...deletedInputs], turns: rows.sort((a, b) => a.sequence - b.sequence), inputTurns: [...inputTurns].map(([inputId, turnId]) => ({ inputId, turnId })) }
}
