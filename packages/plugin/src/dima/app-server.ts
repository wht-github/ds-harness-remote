import path from 'node:path'
import { dimaHistoryRequestSchema, type DimaCatalog, type DimaHistory, type DimaHistoryRequest } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { invalidReply, record, tooLarge, unavailable, withNativeRpc, type DimaOptions, type NativeRpc } from './native-rpc.js'

const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_SESSIONS = 2048
const CATALOG_PAGE_SIZE = 64
const MAX_HISTORY_PAGES = 64
const HISTORY_PAGE_SIZE = 128
const REQUIRED_FEATURES = ['session.catalog', 'session.branches', 'session.history']

type Session = DimaCatalog['workspaces'][number]['sessions'][number]
type Message = DimaHistory['messages'][number]

function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || value.includes('\0')) throw invalidReply()
  return value
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidReply()
  return value
}

function cursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReply()
  return value
}

async function* catalogRows(rpc: NativeRpc) {
  const sessions = new Set<string>()
  const cursors = new Set<string>()
  let nextCursor: string | undefined
  do {
    const page = record(await rpc.call('session.catalog', { limit: CATALOG_PAGE_SIZE, withPreview: true, ...(nextCursor && { cursor: nextCursor }) }))
    const rows = array(page.sessions)
    if (rows.length > CATALOG_PAGE_SIZE) throw invalidReply()
    for (const item of rows) {
      const row = record(item)
      const sessionId = id(row.sessionId)
      if (sessions.has(sessionId)) throw invalidReply()
      sessions.add(sessionId)
      if (sessions.size > MAX_SESSIONS) throw tooLarge()
      if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || row.cwd.includes('\0') || row.cwd.length > 32_768) throw invalidReply()
      if (row.title != null && typeof row.title !== 'string') throw invalidReply()
      if (row.preview != null && typeof row.preview !== 'string') throw invalidReply()
      const title = String(row.title || row.preview || sessionId).slice(0, 8192)
      yield { sessionId, cwd: row.cwd, title }
    }
    if (page.nextCursor === undefined) return
    if (!rows.length || typeof page.nextCursor !== 'string' || !page.nextCursor.length || page.nextCursor.length > 8192 || cursors.has(page.nextCursor)) throw invalidReply()
    nextCursor = page.nextCursor
    cursors.add(nextCursor)
  } while (nextCursor)
}

async function branches(rpc: NativeRpc, sessionId: string): Promise<string[]> {
  const reply = record(await rpc.call('session.branches', { sessionId }))
  const rows = array(reply.branches)
  if (rows.length > 8192) throw tooLarge()
  const ids = rows.map(row => id(record(row).branchId))
  const unique = new Set(ids)
  const current = id(reply.defaultBranchId)
  if (unique.size !== ids.length || !unique.delete(current)) throw invalidReply()
  return [current, ...unique]
}

function userText(user: unknown): string {
  const content = array(record(user).content)
  const text: string[] = []
  for (const [index, item] of content.entries()) {
    const block = record(item)
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') throw invalidReply()
    // The official client treats trailing Skill/Hook context as runtime input.
    if (index > 0 && /^<dim-(?:skill|hooks)(?:>|\s)/.test(block.text)) continue
    text.push(block.text)
  }
  return text.join('\n')
}

/** Fit the largest complete Unicode prefix in the remaining JSON string budget. */
function fitText(text: string, bytes: number): string {
  let low = 0
  let high = Math.min(text.length, Math.max(0, bytes))
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const last = text.charCodeAt(mid - 1)
    const next = text.charCodeAt(mid)
    const end = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? mid + 1 : mid
    if (Buffer.byteLength(JSON.stringify(text.slice(0, end))) - 2 <= bytes) low = end
    else high = mid - 1
  }
  return text.slice(0, low)
}

async function readHistory(rpc: NativeRpc, request: DimaHistoryRequest): Promise<DimaHistory> {
  const result: DimaHistory = { ...request, messages: [], truncated: false }
  const assistants = new Map<string, Message>()
  let bytes = Buffer.byteLength(JSON.stringify(result))
  let after = 0
  let through: number | undefined
  for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
    const page = record(await rpc.call('session.history', { ...request, after, ...(through !== undefined && { through }), limit: HISTORY_PAGE_SIZE }))
    const watermark = cursor(page.through)
    const next = cursor(page.nextAfter)
    const events = array(page.events)
    if (typeof page.done !== 'boolean' || events.length > HISTORY_PAGE_SIZE || (through !== undefined && through !== watermark)
        || next < after || next > watermark || (page.done ? next !== watermark : next <= after)) throw invalidReply()
    through = watermark
    let last = after
    for (const item of events) {
      const event = record(item)
      const sequence = cursor(event.sequence)
      if (sequence <= last || sequence > next || typeof event.type !== 'string' || typeof event.name !== 'string') throw invalidReply()
      last = sequence
      if (event.parent_call_id != null) continue
      let message: Message
      let existing: Message | undefined
      if (event.type === 'input' && event.name === 'message') {
        const data = record(event.data)
        if (data.user == null) continue
        message = { role: 'user', text: userText(data.user) }
      } else if (event.type === 'step' && event.name === 'text') {
        const data = record(event.data)
        const requestId = id(data.request_id)
        if (typeof data.delta !== 'string') throw invalidReply()
        message = { role: 'assistant', text: data.delta }
        existing = assistants.get(requestId)
        if (!existing && message.text.length) assistants.set(requestId, message)
      } else continue
      if (!message.text) continue
      // Budget the escaped wire representation, including quotes/control text.
      const overhead = existing ? 0 : Buffer.byteLength(JSON.stringify({ role: message.role, text: '' })) + 1
      const available = MAX_RESULT_BYTES - bytes - overhead
      const textBytes = Buffer.byteLength(JSON.stringify(message.text)) - 2
      if (textBytes > available) {
        message.text = fitText(message.text, available)
        result.truncated = true
      }
      if (existing) existing.text += message.text
      else if (message.text) result.messages.push(message)
      if (result.truncated) return result
      bytes += overhead + textBytes
    }
    if (page.done) return result
    after = next
  }
  return { ...result, truncated: true }
}

export class DimaAppServer {
  private active = 0
  private probing?: Promise<boolean>
  private lastProbe?: { available: boolean; expires: number }

  constructor(private readonly options: DimaOptions = {}) {}

  probe(): Promise<boolean> {
    if (this.lastProbe && Date.now() < this.lastProbe.expires) return Promise.resolve(this.lastProbe.available)
    this.probing ??= this.run(1500, async () => true).catch(() => false).then(available => {
      this.lastProbe = { available, expires: Date.now() + 2500 }
      return available
    }).finally(() => { this.probing = undefined })
    return this.probing
  }

  catalog(): Promise<DimaCatalog> {
    return this.run(15_000, async rpc => {
      const workspaces = new Map<string, Session[]>()
      let bytes = Buffer.byteLength('{"workspaces":[]}')
      for await (const { sessionId, title, cwd } of catalogRows(rpc)) {
        let sessions = workspaces.get(cwd)
        if (!sessions) {
          sessions = []
          workspaces.set(cwd, sessions)
          bytes += Buffer.byteLength(JSON.stringify({ cwd, sessions })) + 1
        }
        const session = { sessionId, title, branches: await branches(rpc, sessionId) }
        bytes += Buffer.byteLength(JSON.stringify(session)) + 1
        if (bytes > MAX_RESULT_BYTES) throw tooLarge()
        sessions.push(session)
      }
      return { workspaces: [...workspaces].map(([cwd, sessions]) => ({ cwd, sessions })) }
    })
  }

  async history(input: DimaHistoryRequest): Promise<DimaHistory> {
    const parsed = dimaHistoryRequestSchema.safeParse(input)
    if (!parsed.success || parsed.data.sessionId.includes('\0') || parsed.data.branchId.includes('\0')) {
      throw new RpcError('INVALID_MESSAGE', 'Invalid DimAgent history request.')
    }
    const request = parsed.data
    return this.run(15_000, async rpc => {
      for await (const row of catalogRows(rpc)) {
        if (row.sessionId !== request.sessionId) continue
        if ((await branches(rpc, row.sessionId)).includes(request.branchId)) return readHistory(rpc, request)
        break
      }
      throw new RpcError('DIMA_NOT_FOUND', 'The DimAgent session or branch is unavailable.')
    })
  }

  private async run<T>(timeout: number, work: (rpc: NativeRpc) => Promise<T>): Promise<T> {
    if (this.active >= 4) throw new RpcError('RATE_LIMITED', 'Too many DimAgent reads are in progress.')
    this.active++
    const signal = AbortSignal.timeout(timeout)
    try {
      return await withNativeRpc(this.options, signal, async rpc => {
        const hello = record(await rpc.call('hello', { protocolVersion: 4, clientKind: 'other', clientName: 'ds-harness-remote' }))
        if (hello.protocolVersion !== 4 || typeof hello.instanceId !== 'string' || !hello.instanceId
          || typeof hello.serverVersion !== 'string' || !hello.serverVersion
          || !Array.isArray(hello.features) || !REQUIRED_FEATURES.every(feature => (hello.features as unknown[]).includes(feature))) {
          throw new RpcError('DIMA_INCOMPATIBLE', 'DimAgent lacks the required native read capabilities.')
        }
        return work(rpc)
      })
    } catch (error) {
      if (signal.aborted) throw new RpcError('DIMA_TIMEOUT', 'DimAgent read timed out.')
      if (error instanceof RpcError) throw error
      throw unavailable()
    } finally { this.active-- }
  }
}
