import { z } from 'zod'
import { dimaHistoryRequestSchema } from './dima.js'

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const id = z.string().min(1).max(2048)
const content = z.string().max(64 * 1024)
export const dimaTimelineCursorSchema = dimaHistoryRequestSchema.extend({ through: sequence, before: sequence.positive(), instanceId: id })
export const dimaTimelineRequestSchema = dimaHistoryRequestSchema.extend({ cursor: dimaTimelineCursorSchema.optional() })
export const dimaTimelineBlockSchema = z.object({
  id, kind: z.enum(['user', 'text', 'thinking', 'tool']), sequence, text: content,
  requestId: id.optional(), tool: id.optional(), input: content.optional(), output: content.optional(), diff: content.optional(),
  state: z.enum(['running', 'completed', 'failed']).optional(), truncated: z.boolean().optional(),
  live: z.boolean().optional(), liveOffset: sequence.optional(), liveInput: z.boolean().optional(),
  attachments: z.array(z.object({ fileId: id, mediaType: z.string().min(1).max(128) }).strict()).max(64).optional(),
  // The original delta lengths let a refreshed window replace overlapping text exactly.
  parts: z.array(z.object({ id, sequence, length: sequence }).strict()).max(4096).optional(),
}).strict()
const turn = z.object({ id, sequence, lastEvent: sequence.optional(), status: z.enum(['running', 'completed', 'failed', 'cancelled']).optional(),
  startedAt: sequence.optional(), endedAt: sequence.optional(),
  usage: z.array(z.object({ requestId: id, promptTokens: z.number().nonnegative(), completionTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(), cacheReadTokens: z.number().nonnegative().optional(), cacheWriteTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(), cost: z.number().optional(), currency: z.string().max(32).optional() }).strict()).max(1024).optional(),
  detail: z.string().max(2048).optional(), blocks: z.array(dimaTimelineBlockSchema).max(1024) }).strict()
export const dimaTimelineSchema = dimaHistoryRequestSchema.extend({
  instanceId: id, through: sequence, from: sequence, to: sequence, earlier: dimaTimelineCursorSchema.optional(),
  deletedInputs: z.array(id).max(1024).optional(),
  pendingConsumes: z.array(z.object({ inputId: id, sequence }).strict()).max(1024).optional(),
  inputTurns: z.array(z.object({ inputId: id, turnId: id }).strict()).max(1024).optional(),
  turns: z.array(turn).max(1024), activity: z.object({ running: z.boolean(), stopping: z.boolean() }).strict().optional(),
}).refine(page => page.from <= page.to && (!page.earlier || (page.earlier.through <= page.through
  && page.earlier.instanceId === page.instanceId && page.earlier.sessionId === page.sessionId && page.earlier.branchId === page.branchId
  && page.earlier.before === page.from)), 'Invalid DimAgent timeline window.')
export const dimaTimelineOperations = { timeline: { request: dimaTimelineRequestSchema, result: dimaTimelineSchema } } as const
export type DimaTimeline = z.infer<typeof dimaTimelineSchema>
export type DimaTimelineRequest = z.infer<typeof dimaTimelineRequestSchema>
export type DimaTimelineCursor = z.infer<typeof dimaTimelineCursorSchema>
export type DimaTimelineTurn = z.infer<typeof turn>
export type DimaTimelineBlock = z.infer<typeof dimaTimelineBlockSchema>

/** Expanding by native delta id makes windows that split a run in different places overlap exactly. */
function mergeBlock(rows: Map<string, DimaTimelineBlock>, block: DimaTimelineBlock, latest: boolean) {
  if (!block.parts?.length) {
    if (!latest && block.liveInput) {
      const { input: _input, liveInput: _liveInput, ...committed } = block
      block = committed
    }
    const prior = rows.get(block.id)
    if (prior && block.kind === 'tool') rows.set(block.id, { ...prior, ...block, sequence: Math.min(prior.sequence, block.sequence) })
    else if (prior?.parts && block.live) {
      // The original part id may belong to an older page. Attach its speculative
      // suffix after the last durable delta of that part, including later pages.
      const request = [...rows.values()].filter(p => p.requestId === block.requestId).sort((a, b) => a.sequence - b.sequence)
      let tail = prior, written = 0
      for (const part of request) {
        if (part.kind !== block.kind || !part.parts) {
          if (part.sequence > prior.sequence) break
          continue
        }
        written += [...part.text.slice(0, part.parts[0].length)].length
        if (part.sequence >= prior.sequence) tail = part
      }
      let skip = Math.max(0, written - (block.liveOffset ?? 0)), start = 0
      for (const char of block.text) { if (skip-- <= 0) break; start += char.length }
      if (start < block.text.length) {
        const text = tail.text.slice(0, tail.parts![0].length) + block.text.slice(start)
        rows.set(tail.id, { ...tail, text: text.slice(0, 65536), ...(text.length > 65536 && { truncated: true }) })
      }
    } else rows.set(block.id, block)
    return
  }
  let offset = 0
  for (const [i, part] of block.parts.entries()) {
    let written = block.text.slice(offset, offset + part.length)
    offset += part.length
    const prior = rows.get(part.id)
    if (prior?.parts && prior.parts[0].length > written.length) written = prior.text.slice(0, prior.parts[0].length)
    const suffix = latest && i === block.parts.length - 1 ? block.text.slice(offset) : ''
    rows.set(part.id, { ...block, id: part.id, sequence: part.sequence, text: written + suffix,
      parts: [{ ...part, length: written.length }] })
  }
}

/** First argument is chronologically older. Reopen on gaps and on a changed native instance. */
export function mergeDimaTimelinePages(older: DimaTimeline, newer: DimaTimeline): DimaTimeline {
  if (older === newer || older.sessionId !== newer.sessionId || older.branchId !== newer.branchId || older.instanceId !== newer.instanceId
      || older.to < newer.from - 1 || older.through > newer.through) return newer
  const inputTurns = new Map([...older.inputTurns ?? [], ...newer.inputTurns ?? []].map(v => [v.inputId, v.turnId]))
  const pendingConsumes = new Map([...(older.pendingConsumes ?? []), ...(newer.pendingConsumes ?? [])].map(v => [v.inputId, v.sequence]))
  const anchors = [...older.turns, ...newer.turns].filter(t => t.lastEvent !== undefined).sort((a, b) => a.lastEvent! - b.lastEvent!)
  for (const [inputId, seq] of pendingConsumes) {
    const anchor = anchors.find(t => t.lastEvent! >= seq)
    if (anchor) { if (!inputTurns.has(inputId)) inputTurns.set(inputId, anchor.id); pendingConsumes.delete(inputId) }
  }
  const deletedInputs = new Set([...(older.deletedInputs ?? []), ...(newer.deletedInputs ?? [])])
  const turns = new Map<string, DimaTimelineTurn>()
  const rows = new Map<string, Map<string, DimaTimelineBlock>>()
  for (const page of [older, newer]) {
    for (const t of page.turns) {
      const id = t.id.startsWith('input:') ? inputTurns.get(t.id.slice(6)) ?? t.id : t.id
      const prev = turns.get(id)
      const blocks = rows.get(id) ?? new Map<string, DimaTimelineBlock>()
      for (const block of t.blocks) {
        if ((page === older && block.live) || (block.kind === 'user' && deletedInputs.has(block.id))) continue
        mergeBlock(blocks, block, page === newer)
      }
      rows.set(id, blocks)
      const usage = new Map([...(prev?.usage ?? []), ...(t.usage ?? [])].map(v => [v.requestId, v]))
      turns.set(id, { ...prev, ...t, id, sequence: Math.min(prev?.sequence ?? t.sequence, t.sequence),
        ...(usage.size && { usage: [...usage.values()] }), blocks: [] })
    }
  }
  let size = 0, count = 0, partCount = 0
  for (const [id, turn] of turns) {
    const open = new Map<string, number>()
    for (const block of [...rows.get(id)!.values()].sort((a, b) => a.sequence - b.sequence)) {
      const request = block.requestId, index = request === undefined ? undefined : open.get(request)
      if (block.parts && index !== undefined && turn.blocks[index].kind === block.kind
          && turn.blocks[index].text.length + block.text.length <= 65536
          && turn.blocks[index].parts!.length + block.parts.length <= 4096) {
        const current = turn.blocks[index]
        current.text += block.text
        current.parts!.push(...block.parts)
        if (block.truncated) current.truncated = true
      } else {
        if (request !== undefined) {
          if (block.parts) open.set(request, turn.blocks.length)
          else open.delete(request)
        }
        turn.blocks.push(block.parts ? { ...block, parts: [...block.parts] } : block)
      }
      partCount += block.parts?.length ?? 0
      size += block.text.length + (block.input?.length ?? 0) + (block.output?.length ?? 0) + (block.diff?.length ?? 0)
    }
    count += turn.blocks.length
  }
  // Keep the user-requested page when a client retention boundary is reached.
  if (count > 1024 || partCount > 16384 || turns.size > 512 || size > 1024 * 1024 || inputTurns.size > 1024 || deletedInputs.size > 1024
      || pendingConsumes.size > 1024 || [...turns.values()].some(t => (t.usage?.length ?? 0) > 1024)) {
    return older.to < newer.from ? older : newer
  }
  const { earlier: _cursor, ...page } = newer
  const earliest = older.from <= newer.from ? older : newer
  return { ...page, from: earliest.from, ...(earliest.earlier && { earlier: earliest.earlier }),
    pendingConsumes: [...pendingConsumes].map(([inputId, sequence]) => ({ inputId, sequence })),
    deletedInputs: [...deletedInputs], inputTurns: [...inputTurns].map(([inputId, turnId]) => ({ inputId, turnId })),
    turns: [...turns.values()].filter(t => t.blocks.length || t.status || t.usage?.length).sort((a, b) => a.sequence - b.sequence) }
}
