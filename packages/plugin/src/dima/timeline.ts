import type { DimaTimeline, DimaTimelineRequest } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { invalidReply, record, tooLarge, type NativeRpc } from './native-rpc.js'
import { position, projectTimeline, records } from './timeline-projection.js'

export const timelineNativeMethods = ['session.history.display'] as const
export function timelineAvailable(features: readonly string[]) {
  return features.includes('session.attach.expectedCwd') && features.includes('session.model.progress')
    && (features.includes('session.history.display.tail') || features.includes('session.history.latestTurn'))
}
type Context = { cwd: string; state: unknown; features: readonly string[]; instanceId: string }
const MAX_BYTES = 2 * 1024 * 1024
const visibleSteps = new Set(['text', 'thinking', 'tool-use-start', 'tool-use', 'tool-call', 'tool-start', 'tool-completed', 'tool-result'])

/** Every live read owns one short native attachment. Closing that RPC releases its state and progress watchers. */
export async function readDimaTimeline(rpc: NativeRpc, query: DimaTimelineRequest, ctx: Context): Promise<DimaTimeline> {
  const { cursor, ...target } = query
  if (!timelineAvailable(ctx.features)) throw new RpcError('DIMA_INCOMPATIBLE', 'DimAgent does not advertise native timeline support.')
  if (cursor && (cursor.instanceId !== ctx.instanceId || cursor.sessionId !== target.sessionId || cursor.branchId !== target.branchId
      || cursor.before > cursor.through)) throw new RpcError('DIMA_CURSOR_STALE', 'Reload the selected DimAgent branch.')
  if (!['open', 'ending', 'ended'].includes(String(ctx.state))) throw invalidReply()
  const display = ctx.features.includes('session.history.display.tail')
  let activity: DimaTimeline['activity']
  let progress: Record<string, unknown> | undefined
  const buffered: Record<string, unknown>[] = []
  function receive(notice: Record<string, unknown>) {
    const name = notice.method
    if (!['session.state', 'session.model.progress', 'session.display', 'session.event', 'session.closed'].includes(String(name))) return
    const params = record(notice.params)
    if (params.sessionId !== target.sessionId) return
    if (name === 'session.closed') throw new RpcError('DIMA_NOT_FOUND', 'The selected DimAgent session closed.')
    if (params.branchId !== target.branchId) return
    if (name === 'session.state') {
      if (typeof params.running !== 'boolean' || typeof params.stopping !== 'boolean') throw invalidReply()
      activity = { running: params.running, stopping: params.stopping }
    } else if (name === 'session.model.progress') progress = params
    else {
      if (buffered.length >= 1024) throw tooLarge()
      buffered.push(record(name === 'session.display' ? params.item : params.event))
    }
  }
  if (!cursor) {
    if (ctx.state === 'ended') activity = { running: false, stopping: false }
    else {
      const attached = record(await rpc.call('session.attach', { sessionId: target.sessionId, expectedCwd: ctx.cwd, ...(display && { display: true }) }, receive))
      if (attached.cwd !== ctx.cwd || attached.sessionId !== target.sessionId) throw invalidReply()
      // alpha.29 sends state followed by its current model-progress cell for each active branch.
      // The history call continues draining notifications in order, including the progress snapshot.
      while (!activity) receive(await rpc.notification())
    }
  }
  let through = cursor?.through
  let before = cursor?.before
  let from = 0, more = false
  const history: Record<string, unknown>[] = []
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const limit = display ? (cursor ? 128 : 64) : (cursor ? 64 : 32)
    const params = { ...target, ...(through !== undefined && { through }), ...(before !== undefined && { before }),
      ...(display ? { tail: true } : !before && { latestTurn: true }), limit }
    const page = record(await rpc.call(display ? 'session.history.display' : 'session.history', params, receive))
    const head = position(page.through), after = position(page.nextAfter)
    const first = page.nextBefore == null ? undefined : position(page.nextBefore)
    if ((through !== undefined && through !== head) || after > head || typeof page.done !== 'boolean'
        || (first !== undefined && (first < 1 || first > head || (before !== undefined && first >= before)))) throw invalidReply()
    through = head
    const events = records(display ? page.items : page.events)
    if (events.length > 8192 || history.length + events.length > 8192) throw tooLarge()
    let prev = (first ?? 1) - 1
    for (const event of events) {
      const seq = position(event.sequence)
      if (first === undefined || seq <= prev || seq > after || (before !== undefined && seq >= before)) throw invalidReply()
      prev = seq
    }
    // Plain display tail scans native positions. A whole span may consist of filtered
    // private events and return done with no item. Continue below that scanned span.
    const top = before === undefined ? head : before - 1
    const boundary = display ? first ?? Math.max(1, top - limit + 1) : first
    more = boundary !== undefined && boundary > 1
    from = more ? boundary! : 0
    history.unshift(...events)
    before = boundary
    if (!more || events.some(e => (e.type === 'input' && e.name === 'message') || (e.type === 'step' && visibleSteps.has(String(e.name))))) break
  }
  if (through === undefined) throw invalidReply()
  let to = cursor ? cursor.before - 1 : through
  for (const event of buffered) {
    const seq = position(event.sequence)
    if (seq <= through) continue
    if (seq <= to) throw invalidReply()
    history.push(event)
    to = seq
  }
  const header = { ...target, instanceId: ctx.instanceId, through, from, to,
    ...(more && before !== undefined && { earlier: { ...target, instanceId: ctx.instanceId, before, through } }), ...(activity && { activity }) }
  for (const maxChars of [65536, 8192, 1024]) {
    const value: DimaTimeline = { ...header, ...projectTimeline(history, activity?.running ? progress : undefined, to, maxChars) }
    if (Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES) return value
  }
  throw tooLarge()
}
