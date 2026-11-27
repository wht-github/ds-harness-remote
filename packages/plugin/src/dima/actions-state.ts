import { createHash } from 'node:crypto'
import type { DimaActionKind, DimaInbox, DimaInboxRequest } from '@dsh-remote/protocol'
import { dimaInboxSchema } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { limited } from './interaction.js'
import { invalidReply, record, tooLarge } from './native-rpc.js'

export const dimaActionNativeMethods = [
  'session.methods', 'session.question.pending', 'session.question.respond', 'session.input.pending', 'session.input.withdraw',
  'session.submit', 'session.input_lookup', 'session.turn.get', 'session.branches', 'session.branch_create', 'session.branch_set_default',
  'session.branch_end', 'session.fork', 'session.model.get', 'session.model.update', 'provider.models.query',
  'session.context.usage', 'session.context.compact', 'agent.list', 'session.agent.update', 'session.rename',
] as const
export type ActionRpc = { call(method: typeof dimaActionNativeMethods[number], params: Record<string, unknown>): Promise<unknown> }
export interface DimaActionContext { owner: string; instanceId: string; features: readonly string[]; state: string }
export const stale = () => new RpcError('DIMA_ACTION_STALE', 'Refresh the selected branch to review its current actions.')
export const unsupported = () => new RpcError('DIMA_INCOMPATIBLE', 'This action is unavailable on the selected DimAgent branch.')
export function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) throw invalidReply()
  if (value.length > limit) throw tooLarge()
  return value
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || value.includes('\0')) throw invalidReply()
  return value
}
export function position(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReply()
  return value
}
export function bounded(value: unknown, bytes = 1024 * 1024) {
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw tooLarge()
}
export async function availableMethods(rpc: ActionRpc, target: DimaInboxRequest, ctx: DimaActionContext) {
  if (!ctx.owner || !ctx.instanceId) throw new RpcError('UNAUTHORIZED', 'An authenticated DimAgent device is required.')
  // Core methods come from hello. Session extension methods come from this Session's live declarations.
  const sessionMethods = new Map<string, boolean>([
    ['session.question.pending', false], ['session.question.respond', true], ['session.input.pending', false], ['session.input.withdraw', true],
    ['session.context.usage', false], ['session.context.compact', true], ['session.agent.update', true], ['session.rename', true],
    ['attachment.import', true], ['attachment.put', true], ['session.files.search', false],
  ])
  const available = new Set(ctx.features.filter(name => !sessionMethods.has(name)))
  if (!available.has('session.methods')) throw unsupported()
  if (ctx.state === 'open') {
    const table = record(await rpc.call('session.methods', { sessionId: target.sessionId }))
    const names = new Set<string>()
    for (const entry of list(table.methods, 4096)) {
      const row = record(entry), name = id(row.name)
      if (typeof row.mutating !== 'boolean' || names.has(name)) throw invalidReply()
      names.add(name)
      if (sessionMethods.get(name) === row.mutating) available.add(name)
    }
    // Protocol v4 agent.list is a built-in without a hello feature. A live Session agent provider establishes its scope.
    if (available.has('session.agent.update')) available.add('agent.list')
  }
  return available
}
export function availableKinds(methods: Set<string>, target: DimaInboxRequest, ctx: DimaActionContext): DimaActionKind[] {
  if (ctx.state !== 'open') return []
  const has = (...names: string[]) => names.every(name => methods.has(name))
  const result: DimaActionKind[] = []
  if (has('session.question.pending', 'session.question.respond')) result.push('answer')
  if (has('session.submit', 'session.input_lookup')) result.push('steer')
  if (has('session.input.pending', 'session.input.pending.blockPresence', 'session.input.withdraw')) result.push('withdraw', 'retrieve', 'steerQueued')
  if (has('session.branches', 'session.branch_create')) result.push('branchCreate')
  if (target.branchId === 'main' && has('session.fork', 'session.turn.get')) result.push('fork')
  if (has('session.branch_set_default')) result.push('setDefault')
  if (target.branchId !== 'main' && has('session.branch_end')) result.push('endBranch')
  if (has('session.agent.update', 'agent.list')) result.push('setAgent')
  if (has('session.rename')) result.push('rename')
  if (has('session.context.compact')) result.push('compact')
  if (has('session.model.get', 'session.model.update', 'provider.models.query')) result.push('setModel', 'setEffort')
  return result
}

type Pending = DimaInbox['questions'][number]
type Input = DimaInbox['queue'][number]
type Held = { view: Input; user: Record<string, unknown> }

/** All continuations use the native opaque cursor and the same cutoff. Return only a complete inventory. */
async function* inventory(rpc: ActionRpc, method: 'session.question.pending' | 'session.input.pending', target: DimaInboxRequest) {
  const seen = new Set<string>()
  let through: number | undefined
  let after: unknown
  let bytes = 0
  let lastSequence = 0
  for (let index = 0; index < 16; index++) {
    const page = record(await rpc.call(method, { ...target, ...(method === 'session.input.pending' ? { includeBlockPresence: true } : {}),
      ...(after === undefined ? {} : { after, through }) }))
    const cut = position(page.through)
    if (page.branchId !== target.branchId || (through !== undefined && cut !== through)) throw invalidReply()
    through = cut
    bytes += Buffer.byteLength(JSON.stringify(page))
    if (bytes > 2 * 1024 * 1024) throw tooLarge()
    const entries = list(page[method === 'session.question.pending' ? 'batches' : 'inputs'], 128)
    for (const item of entries) {
      const row = record(item), sequence = position(row.sequence)
      if (sequence <= lastSequence || sequence > cut) throw invalidReply()
      lastSequence = sequence
      yield row
    }
    if (page.next === null) return
    if (page.next === undefined || !entries.length) throw invalidReply()
    after = record(page.next)
    const cursor = JSON.stringify(after)
    if (cursor.length > 4096 || seen.has(cursor)) throw invalidReply()
    seen.add(cursor)
  }
  throw tooLarge()
}

export async function questions(rpc: ActionRpc, target: DimaInboxRequest): Promise<Pending[]> {
  const result: Pending[] = []
  const keys = new Set<string>()
  for await (const batch of inventory(rpc, 'session.question.pending', target)) {
    const eventId = id(batch.eventId), requestId = id(batch.requestId)
    for (const entry of list(batch.calls, 256)) {
      const call = record(entry)
      if (call.name !== 'ask_user') throw invalidReply()
      const callId = id(call.id), key = JSON.stringify([requestId, callId])
      if (keys.has(key)) throw invalidReply()
      keys.add(key)
      const rows = list(record(call.input).questions, 4).map((value, index) => {
        const q = record(value)
        const options = list(q.options, 6).map(value => {
          const option = record(value)
          return { ...option, description: option.description ?? undefined }
        })
        return { ...q, id: q.id ?? String(index + 1), header: q.header ?? undefined, options,
          multiSelect: q.multiSelect === undefined ? false : q.multiSelect, allowCustom: q.allowCustom === undefined ? true : q.allowCustom }
      })
      const decoded = dimaInboxSchema.shape.questions.element.safeParse({ eventId, requestId, callId, questions: rows })
      if (!decoded.success) throw invalidReply()
      const form = decoded.data.questions
      if (new Set(form.map(q => q.id)).size !== form.length || form.some(q => !q.question.trim() ||
        new Set(q.options.map(o => o.label)).size !== q.options.length || q.options.some(o => !o.label.trim()))) throw invalidReply()
      result.push(decoded.data)
      if (result.length > 256) throw tooLarge()
    }
  }
  return result
}

export async function heldInputs(rpc: ActionRpc, target: DimaInboxRequest): Promise<Map<string, Held>> {
  const result = new Map<string, Held>()
  for await (const row of inventory(rpc, 'session.input.pending', target)) {
    if (typeof row.applied !== 'boolean' || typeof row.hasRawBlocks !== 'boolean') throw invalidReply()
    if (!row.user || row.applied || row.hasRawBlocks || row.mode === 'append') continue
    const inputId = id(row.inputId)
    if (result.has(inputId) || (row.mode !== 'steer' && row.mode !== 'queue')) throw invalidReply()
    const user = record(row.user), content = list(user.content, 1024).map(record)
    const parts = content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (typeof block.type !== 'string') throw invalidReply()
      return '[' + block.type + ']'
    })
    const text = parts.join('\n')
    const editable = Object.keys(user).length === 1 && content.length === 1 && content[0]?.type === 'text' &&
      Object.keys(content[0]).length === 2 && text.length > 0 && text.length <= 65_536
    result.set(inputId, { view: { inputId, mode: row.mode, text: text.length > 65_536 ? text.slice(0, 65_535) + '…' : text, editable }, user })
    if (result.size > 512) throw tooLarge()
  }
  return result
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
/** Device B can take over an outstanding native question or input after reading its own inventory. */
export class ReviewedInventory {
  private readonly views = new Map<string, { expires: number; hashes: Set<string> }>()
  private key(ctx: DimaActionContext, target: DimaInboxRequest) { return hash([ctx.owner, ctx.instanceId, target.sessionId, target.branchId]) }
  show(ctx: DimaActionContext, target: DimaInboxRequest, rows: unknown[]) {
    const now = Date.now()
    for (const [key, value] of this.views) if (value.expires <= now) this.views.delete(key)
    const key = this.key(ctx, target)
    this.views.delete(key)
    if (!rows.length) return
    if (this.views.size >= 512) throw limited()
    this.views.set(key, { expires: now + 300_000, hashes: new Set(rows.map(hash)) })
  }
  require(ctx: DimaActionContext, target: DimaInboxRequest, row: unknown) {
    const stored = this.views.get(this.key(ctx, target))
    if (!stored || stored.expires <= Date.now() || !stored.hashes.has(hash(row))) throw stale()
  }
  clear() { this.views.clear() }
}
