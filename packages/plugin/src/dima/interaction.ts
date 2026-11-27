import { createHash } from 'node:crypto'
import { dimaApprovalSchema, type DimaApproval, type DimaHistoryRequest, type DimaStatus } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { invalidReply, record, unknownOutcome, type NativeRpc } from './native-rpc.js'

export const notFound = () => new RpcError('DIMA_NOT_FOUND', 'The DimAgent workspace, session or branch is unavailable.')
const staleApproval = () => new RpcError('DIMA_APPROVAL_STALE', 'Refresh the branch to review the current DimAgent approval.')
export const limited = () => new RpcError('RATE_LIMITED', 'Too many DimAgent operations are in progress.')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A receipt retains a digest and a result, never the operator's text. */
export class Receipts<T> {
  private readonly entries = new Map<string, { digest: string; result: Promise<T>; expires: number }>()

  once(owner: string, requestId: string, payload: unknown, work: () => Promise<T>): Promise<T> {
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key)
    const key = digest([owner, requestId])
    const fingerprint = digest(payload)
    const prior = this.entries.get(key)
    if (prior) {
      if (prior.digest !== fingerprint) throw new RpcError('DIMA_REQUEST_CONFLICT', 'This request ID already identifies a different operation.')
      return prior.result
    }
    if (this.entries.size >= 2048) throw limited()
    const result = work()
    this.entries.set(key, { digest: fingerprint, result, expires: now + 24 * 60 * 60_000 })
    return result
  }

  clear() { this.entries.clear() }
}

/** Native errors give a decision. A missing/unusable receipt after dispatch cannot prove rejection. */
export async function mutation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof RpcError && (error.code === 'DIMA_REQUEST_FAILED' || error.code === 'DIMA_ACTION_STALE')) throw error
    throw unknownOutcome()
  }
}

const localReview = () => new RpcError('DIMA_APPROVAL_TOO_LARGE', 'Review this approval in the local DimAgent client to see its full details.')

function approvalInput(value: unknown) {
  // JSON.parse decodes native 64-bit integers into doubles. A rounded argument
  // would present a different operation than the one being authorized.
  return JSON.stringify(record(value), (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) throw localReview()
    return item
  })
}

export async function branchSnapshot(rpc: NativeRpc, target: DimaHistoryRequest, cwd: string, review: boolean): Promise<DimaStatus> {
  const attached = record(await rpc.call('session.attach', { sessionId: target.sessionId, expectedCwd: cwd }))
  if (attached.sessionId !== target.sessionId || attached.cwd !== cwd) throw invalidReply()
  // alpha.29 replays pending approvals after the attach reply, before it starts emitting
  // initial session.state for each branch (connection/subscription.rs, replay then follow).
  const approvals = new Map<string, DimaApproval>()
  for (;;) {
    const notice = await rpc.notification()
    if (!['session.state', 'approval.request', 'approval.resolved', 'approval.cancelled', 'session.closed'].includes(String(notice.method))) continue
    const p = record(notice.params)
    if (p.sessionId !== target.sessionId) continue
    if (notice.method === 'session.closed') throw notFound()
    if (p.branchId !== target.branchId) continue
    if (notice.method === 'session.state') {
      if (typeof p.running !== 'boolean' || typeof p.stopping !== 'boolean') throw invalidReply()
      const result = { ...target, running: p.running, stopping: p.stopping, approvals: [...approvals.values()] }
      if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw localReview()
      return result
    }
    if (!review) continue
    if (typeof p.requestId !== 'string' || !p.requestId || p.requestId.length > 512) throw invalidReply()
    if (notice.method !== 'approval.request') { approvals.delete(p.requestId); continue }
    const call = record(p.call)
    const approval = dimaApprovalSchema.safeParse({ requestId: p.requestId, tool: call.name, reason: p.reason, input: approvalInput(call.input) })
    if (!approval.success || (!approvals.has(p.requestId) && approvals.size >= 64)) {
      throw localReview()
    }
    approvals.set(p.requestId, approval.data)
  }
}

/** Only a complete approval shown to this owner on this daemon can be consumed. */
export class ReviewedApprovals {
  private readonly seen = new Map<string, { choices: Set<string>; expires: number }>()

  show(owner: string, instance: string, status: DimaStatus) {
    const now = Date.now()
    for (const [key, entry] of this.seen) if (entry.expires <= now) this.seen.delete(key)
    const key = digest([owner, instance, status.sessionId, status.branchId])
    this.seen.delete(key)
    if (!status.approvals?.length) return
    if (this.seen.size >= 512) throw limited()
    this.seen.set(key, { choices: new Set(status.approvals.map(digest)), expires: now + 5 * 60_000 })
  }

  consume(owner: string, instance: string, target: DimaHistoryRequest, approval: DimaApproval | undefined) {
    const key = digest([owner, instance, target.sessionId, target.branchId])
    const entry = this.seen.get(key)
    if (!approval || !entry || entry.expires <= Date.now() || !entry.choices.delete(digest(approval))) throw staleApproval()
    if (!entry.choices.size) this.seen.delete(key)
  }

  clear() { this.seen.clear() }
}
