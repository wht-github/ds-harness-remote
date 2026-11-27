import { setTimeout as delay } from 'node:timers/promises'
import type { DimaHistoryRequest, DimaTaskKey, DimaTaskRequest, DimaTaskResult, DimaTaskTarget } from '@dsh-remote/protocol'
import { dimaTasksOperations } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { mutation, notFound } from './interaction.js'
import { invalidReply, record, tooLarge, type NativeRpc } from './native-rpc.js'
import { memberPreview } from './tasks-export.js'
export { conversationExport } from './tasks-export.js'

const goalMethods = { set: 'session.goal.set', edit: 'session.goal.edit', pause: 'session.goal.pause', resume: 'session.goal.resume', clear: 'session.goal.clear' } as const
export const tasksNativeMethods = ['session.methods', 'session.goal.get', ...Object.values(goalMethods), 'session.branches',
  'session.exec.pending', 'session.exec.finished', 'session.collaboration.pending', 'session.collaboration.finished',
  'session.exec.output', 'session.exec.output.page', 'session.exec.stop', 'session.collaboration.cancel', 'workflow.status', 'workflow.stop', 'session.history'] as const
const incompatible = () => new RpcError('DIMA_INCOMPATIBLE', 'DimAgent does not support this operation for the selected session.')
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw invalidReply()
  return value
}
function rows(value: unknown, limit = 2048) {
  if (!Array.isArray(value)) throw invalidReply()
  if (value.length > limit) throw tooLarge()
  return value.map(record)
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw invalidReply()
  return value
}
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReply()
  return value
}
const branchOf = ({ sessionId, branchId }: DimaHistoryRequest) => ({ sessionId, branchId })
export function tasksSupportedOperations(hello: readonly string[], sessionMethods?: readonly string[]): DimaTaskKey[] {
  const source = new Set([...hello, ...(sessionMethods ?? [])])
  const operations: DimaTaskKey[] = []
  // Extensions are declared by the selected Session. A Host-wide handshake can
  // advertise these typed requests; each call consults that Session's table.
  if (sessionMethods === undefined && source.has('session.methods')) return [
    'goal', 'goalUpdate', 'tasks', 'taskDetail', 'taskStop', ...(source.has('session.history') ? ['conversationExport' as const] : []),
  ]
  if (source.has('session.history')) operations.push('conversationExport')
  if (source.has('session.goal.get')) operations.push('goal')
  if (source.has('session.goal.get') && Object.values(goalMethods).every(method => source.has(method))) operations.push('goalUpdate')
  if (['session.exec.pending', 'session.collaboration.pending', 'workflow.status'].some(method => source.has(method))) {
    operations.push('tasks', 'taskDetail')
    if (source.has('session.exec.pending') && source.has('session.exec.stop') || source.has('session.collaboration.pending') && source.has('session.collaboration.finished') && source.has('session.collaboration.cancel') || source.has('workflow.status') && source.has('workflow.stop')) operations.push('taskStop')
  }
  return operations
}
async function methods(rpc: NativeRpc, sessionId: string, features: readonly string[]) {
  const result = new Set(features)
  if (result.has('session.methods')) {
    const table = record(await rpc.call('session.methods', { sessionId }))
    for (const method of rows(table.methods)) result.add(id(method.name))
  }
  return result
}
async function readGoal(rpc: NativeRpc, target: DimaHistoryRequest): Promise<DimaTaskResult<'goal'>> {
  const reply = record(await rpc.call('session.goal.get', branchOf(target)))
  if (reply.branchId !== target.branchId) throw invalidReply()
  sequence(reply.through)
  if (reply.goal === null) return { ...target, goal: null }
  const value = record(reply.goal), status = record(value.status)
  const checked = dimaTasksOperations.goal.result.safeParse({ ...branchOf(target), goal: { objective: value.objective, status: status.kind, reason: status.reason } })
  if (!checked.success) throw invalidReply()
  return checked.data
}
export async function goal(rpc: NativeRpc, p: DimaTaskRequest<'goal'>, features: readonly string[]) {
  if (!(await methods(rpc, p.sessionId, features)).has('session.goal.get')) throw incompatible()
  return readGoal(rpc, branchOf(p))
}
export async function goalUpdate(rpc: NativeRpc, p: DimaTaskRequest<'goalUpdate'>, features: readonly string[]) {
  const method = goalMethods[p.action], available = await methods(rpc, p.sessionId, features)
  if (!available.has(method) || !available.has('session.goal.get')) throw incompatible()
  const branch = branchOf(p)
  return mutation(async () => {
    sequence(record(await rpc.call(method, { ...branch, ...('objective' in p && { objective: p.objective }) })).sequence)
    return { ...await readGoal(rpc, branch), operationId: p.operationId }
  })
}

type Row = DimaTaskResult<'tasks'>['items'][number]
type Item = { row: Row; detail: string; member?: string; inputEventId?: string; finished: boolean; started: number }
type InventoryMethod = 'session.exec.pending' | 'session.exec.finished' | 'session.collaboration.pending' | 'session.collaboration.finished'
function itemFrom(branchId: string, method: InventoryMethod, value: Record<string, unknown>, available: Set<string>): Item {
  const finished = method.endsWith('.finished'), start = finished ? record(value.start) : value
  const started = sequence(start.startedAt)
  if (method.startsWith('session.exec.')) {
    const target: DimaTaskTarget = { kind: 'command', branchId, id: id(start.taskId) }
    const end = finished ? record(value.end) : undefined
    if (end && end.task_id !== target.id) throw invalidReply()
    const label = text(start.title ?? start.description).slice(0, 2048)
    const state = end ? id(end.status) : 'running'
    const content = end ? record(end.result).content : start.description
    const detail = typeof content === 'string' ? content : rows(content).map(block => block.type === 'text' ? text(block.text) : '[' + id(block.type) + ']').join('\n')
    return { row: { target, label, state, canStop: !finished && available.has('session.exec.stop') }, detail, finished, started }
  }
  const target: DimaTaskTarget = { kind: 'member', branchId, id: id(start.eventId) }, request = record(start.request)
  const delivery = start.delivery == null ? undefined : record(start.delivery)
  const member = delivery?.status === 'ok' ? id(delivery.session_id) : undefined
  const result = value.result == null ? undefined : record(value.result)
  if (result && (result.request_event_id !== target.id || result.session_id !== member)) throw invalidReply()
  const state = result ? id(result.status) : delivery?.status === 'error' ? 'failed' : member ? 'running' : 'starting'
  const detail = text(result?.text ?? delivery?.error ?? request.prompt)
  const inputEventId = delivery?.input_event_id == null ? undefined : id(delivery.input_event_id)
  return { row: { target, state, label: text(request.title ?? request.prompt).slice(0, 2048), canStop: !!member && !finished && available.has('session.collaboration.cancel') && available.has('session.collaboration.finished') }, detail, member, inputEventId, finished, started }
}
function workflowItem(run: Record<string, unknown>, sessionId: string, available: Set<string>): Item | undefined {
  const started = typeof run.started_by === 'object' && run.started_by !== null ? record(run.started_by) : undefined
  const recipient = run.report_to == null ? undefined : record(run.report_to)
  const address = started?.session_id === sessionId ? started : recipient?.session_id === sessionId ? recipient : undefined
  if (!address) return
  const target: DimaTaskTarget = { kind: 'workflow', branchId: id(address.branch_id), id: id(run.run_id) }
  const state = id(run.state), label = text(run.name).slice(0, 2048)
  const detail = [...rows(run.stages).map(stage => [id(stage.id), id(stage.state), stage.result_text, stage.reason].filter(Boolean).join(' · ')),
    ...rows(run.log).map(entry => text(entry.message))].join('\n')
  return { row: { target, label, state, canStop: state === 'running' && available.has('workflow.stop') }, detail, finished: state !== 'running' && state !== 'stopping', started: Date.parse(text(run.created_at)) || 0 }
}
async function inventory(rpc: NativeRpc, target: DimaHistoryRequest, features: readonly string[], wanted?: DimaTaskTarget) {
  const available = await methods(rpc, target.sessionId, features)
  const sources = { commands: available.has('session.exec.pending'), members: available.has('session.collaboration.pending'), workflows: available.has('workflow.status') }
  if (!Object.values(sources).includes(true)) throw incompatible()
  const directory = record(await rpc.call('session.branches', { sessionId: target.sessionId }))
  const branches = new Map<string, { head: number; ended: boolean }>()
  for (const row of rows(directory.branches, 256)) {
    const branchId = id(row.branchId)
    if (branches.has(branchId)) throw invalidReply()
    branches.set(branchId, { head: sequence(row.head), ended: row.state === 'ended' })
  }
  if (!branches.has(target.branchId) || wanted && !branches.has(wanted.branchId)) throw notFound()
  const items: Item[] = [], seen = new Set<string>()
  const activeMembers = new Map<string, Item>()
  const add = (item: Item) => {
    const identity = JSON.stringify(item.row.target)
    if (seen.has(identity)) throw invalidReply()
    seen.add(identity)
    if (item.member && !item.finished) {
      // Native cancellation addresses the member on the leader's branch. Two
      // current records for that address do not identify one stoppable request.
      const address = JSON.stringify([item.row.target.branchId, item.member])
      const previous = activeMembers.get(address)
      if (item.member === target.sessionId || previous) item.row.canStop = false
      if (previous) previous.row.canStop = false
      activeMembers.set(address, item)
    }
    if (!wanted || wanted.id !== item.row.target.id || wanted.kind !== item.row.target.kind || wanted.branchId !== item.row.target.branchId) item.detail = ''
    items.push(item)
    if (items.length > 2048) throw tooLarge()
  }
  const inventories: InventoryMethod[] = ['session.exec.finished', 'session.exec.pending', 'session.collaboration.finished', 'session.collaboration.pending']
  for (const [branchId, { head: through, ended }] of branches) {
    if (wanted && branchId !== wanted.branchId) continue
    for (const method of inventories) {
      const command = method.startsWith('session.exec.')
      if (!available.has(method) || ended && method.endsWith('.pending') || wanted && wanted.kind !== (command ? 'command' : 'member')) continue
      const cursors = new Set<string>()
      let after: unknown
      do {
        const page = record(await rpc.call(method, { sessionId: target.sessionId, branchId, through, ...(after != null && { after }) }))
        if (page.branchId !== branchId || page.through !== through) throw invalidReply()
        for (const row of rows(command ? page.tasks : page.requests)) add(itemFrom(branchId, method, row, available))
        after = page.next
        if (after != null) {
          const key = JSON.stringify(after)
          if (key.length > 8192 || cursors.has(key)) throw invalidReply()
          if (cursors.size >= 64) throw tooLarge()
          cursors.add(key)
        }
      } while (after != null)
    }
  }
  if (sources.workflows && (!wanted || wanted.kind === 'workflow')) {
    for (const run of rows(await rpc.call('workflow.status', {}), 4096)) {
      const item = workflowItem(run, target.sessionId, available)
      if (item && branches.has(item.row.target.branchId)) add(item)
    }
  }
  return { available, items, sources }
}
export async function tasks(rpc: NativeRpc, p: DimaTaskRequest<'tasks'>, features: readonly string[]) {
  const { items, sources } = await inventory(rpc, p, features)
  const result = { ...branchOf(p), sources, items: items.sort((a,b) => a.started - b.started).map(x => x.row) }
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw tooLarge()
  return result
}
async function selected(rpc: NativeRpc, p: DimaTaskRequest<'taskDetail'>, features: readonly string[]) {
  const { items, available } = await inventory(rpc, p, features, p.target)
  const item = items.find(({ row: { target } }) => target.kind === p.target.kind && target.id === p.target.id && target.branchId === p.target.branchId)
  if (!item) throw notFound()
  if (item.row.target.kind !== 'workflow') return { item, available }
  const fresh = workflowItem(record(await rpc.call('workflow.status', { run_id: p.target.id })), p.sessionId, available)
  if (!fresh || fresh.row.target.branchId !== p.target.branchId || fresh.row.target.id !== p.target.id) throw notFound()
  return { item: fresh, available }
}
export async function taskDetail(rpc: NativeRpc, p: DimaTaskRequest<'taskDetail'>, features: readonly string[]) {
  const { item, available } = await selected(rpc, p, features)
  let detail = item.detail, more = false
  if (!item.finished && p.target.kind === 'command' && available.has('session.exec.output.page')) {
    const page = record(await rpc.call('session.exec.output.page', { sessionId: p.sessionId, branchId: p.target.branchId, taskId: p.target.id, cursor: 0, limit: 65536 }))
    detail = text(page.text)
    if (typeof page.truncated !== 'boolean') throw invalidReply()
    more = page.truncated || page.nextCursor != null
  } else if (!item.finished && p.target.kind === 'command' && available.has('session.exec.output')) {
    detail = text(record(await rpc.call('session.exec.output', { sessionId: p.sessionId, branchId: p.target.branchId, taskId: p.target.id })).text)
    more = true // Older native daemons expose only a tail preview.
  } else if (!item.finished && item.member && item.member !== p.sessionId && item.inputEventId && available.has('session.history.latestTurn')) {
    const preview = await memberPreview(rpc, item.member, item.inputEventId)
    detail = preview.text || detail
    more = preview.truncated
  }
  return { ...p, text: detail.slice(0, 65_536), truncated: more || detail.length > 65_536 }
}
export async function taskStop(rpc: NativeRpc, p: DimaTaskRequest<'taskStop'>, features: readonly string[]) {
  const { item, available } = await selected(rpc, p, features)
  if (!item.row.canStop) throw notFound()
  return mutation(async () => {
    if (p.target.kind === 'command') {
      const end = record(await rpc.call('session.exec.stop', { sessionId: p.sessionId, branchId: p.target.branchId, taskId: p.target.id }))
      if (end.task_id !== p.target.id || end.status !== 'cancelled') throw invalidReply()
    } else if (p.target.kind === 'workflow') {
      const end = workflowItem(record(await rpc.call('workflow.stop', { run_id: p.target.id })), p.sessionId, available)
      if (!end || end.row.target.id !== p.target.id || end.row.target.branchId !== p.target.branchId || !['stopping', 'stopped'].includes(end.row.state)) throw invalidReply()
    } else {
      if (!item.member || item.member === p.sessionId) throw invalidReply()
      const reply = record(await rpc.call('session.collaboration.cancel', { sessionId: p.sessionId, branchId: p.target.branchId, memberSessionId: item.member }))
      if (reply.status !== 'cancelled') throw invalidReply()
      // The native acknowledgement names the member. Confirm this request's
      // terminal record before issuing a receipt for its public event ID.
      let terminal = (await selected(rpc, p, features)).item
      for (const wait of [25, 50, 100, 200, 400, 800]) {
        if (terminal.finished || terminal.member !== item.member) break
        await delay(wait)
        terminal = (await selected(rpc, p, features)).item
      }
      if (!terminal.finished || terminal.member !== item.member || terminal.row.state !== 'cancelled') throw invalidReply()
    }
    return { ...p }
  })
}
