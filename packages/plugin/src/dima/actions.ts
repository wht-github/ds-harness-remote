import {
  dimaActionRequestSchema, dimaActionResultSchema, dimaInboxRequestSchema, dimaInboxSchema, dimaOptionsRequestSchema,
  type DimaActionRequest, type DimaActionResult, type DimaInbox, type DimaInboxRequest,
} from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { mutation, Receipts } from './interaction.js'
import { invalidReply, record } from './native-rpc.js'
import { availableKinds, availableMethods, bounded, heldInputs, id, list, position, questions, ReviewedInventory,
  stale, unsupported, type ActionRpc, type DimaActionContext } from './actions-state.js'
import { selectableAgents, sessionOptions } from './actions-options.js'

export { dimaActionNativeMethods, type DimaActionContext } from './actions-state.js'
const targetOf = (r: DimaInboxRequest) => ({ sessionId: r.sessionId, branchId: r.branchId })
const badAnswer = () => new RpcError('DIMA_INVALID_ANSWER', 'The answers do not match the questions on this branch.')
const conflict = () => new RpcError('DIMA_REQUEST_CONFLICT', 'A different native input already uses this operation ID.')
function empty(reply: unknown) { if (Object.keys(record(reply)).length) throw invalidReply() }

function validateAnswers(request: Extract<DimaActionRequest, { kind: 'answer' }>, current: DimaInbox['questions'][number]) {
  if (request.declined) return { declined: true }
  const answers = request.answers ?? []
  const byId = new Map(answers.map(a => [a.questionId, a]))
  if (byId.size !== current.questions.length || byId.size !== answers.length) throw badAnswer()
  return { answers: current.questions.map(q => {
    const a = byId.get(q.id)
    if (!a || (!q.multiSelect && a.selected.length + Number(a.custom !== undefined) > 1) || new Set(a.selected).size !== a.selected.length
      || a.selected.some(s => !q.options.some(o => s === o.label)) || (a.custom !== undefined && (!q.allowCustom || !a.custom.trim()))
      || (!a.selected.length && !a.custom?.trim())) throw badAnswer()
    return a
  }) }
}

async function submitSteer(rpc: ActionRpc, req: Extract<DimaActionRequest, { kind: 'steer' }>) {
  const identity = { ...targetOf(req), submissionId: req.operationId }
  const confirm = (receipt: unknown) => {
    const event = record(record(receipt).event), data = record(event.data)
    if (event.type !== 'input' || event.name !== 'message' || data.submission_id !== req.operationId) throw invalidReply()
    const content = list(record(data.user).content, 1024)
    if (data.mode !== 'steer' || !content.length || record(content[0]).type !== 'text' || record(content[0]).text !== req.text) throw conflict()
  }
  const found = record(await rpc.call('session.input_lookup', identity))
  if (found.status === 'accepted') return confirm(found)
  if (found.status !== 'unknown') throw invalidReply()
  await mutation(async () => confirm(await rpc.call('session.submit', { ...identity, mode: 'steer', text: req.text })))
}

function finishAt(turn: unknown, target: DimaInboxRequest) {
  const row = record(turn)
  if (row.branchId !== target.branchId) throw invalidReply()
  position(row.through)
  if (row.turn === null) throw new RpcError('DIMA_NO_FINISHED_TURN', 'There is no finished turn to fork.')
  const boundary = record(row.turn)
  id(boundary.turnId)
  if (typeof boundary.ended !== 'boolean') throw invalidReply()
  const sequence = position(boundary.sequence)
  if (!sequence || sequence > (row.through as number)) throw invalidReply()
  return { ended: boundary.ended, sequence }
}

export class DimaActions {
  private readonly reviewed = new ReviewedInventory()
  private readonly reviewedModels = new ReviewedInventory()
  private readonly receipts = new Receipts<DimaActionResult>()

  clear() { this.reviewed.clear(); this.reviewedModels.clear(); this.receipts.clear() }

  async inbox(rpc: ActionRpc, input: DimaInboxRequest, ctx: DimaActionContext): Promise<DimaInbox> {
    const target = dimaInboxRequestSchema.parse(input)
    const methods = await availableMethods(rpc, target, ctx)
    const actions = availableKinds(methods, target, ctx)
    const pending = ctx.state === 'open' && methods.has('session.question.pending') ? await questions(rpc, target) : []
    const held = ctx.state === 'open' && methods.has('session.input.pending') && methods.has('session.input.pending.blockPresence')
      ? [...(await heldInputs(rpc, target)).values()] : []
    const result = { ...target, actions, questions: pending, queue: held.map(i => i.view),
      media: { image: methods.has('attachment.import'), paste: methods.has('attachment.put'), file: methods.has('session.files.search') } }
    bounded(result)
    const parsed = dimaInboxSchema.safeParse(result)
    if (!parsed.success) throw invalidReply()
    this.reviewed.show(ctx, target, [...pending, ...held])
    return parsed.data
  }

  async options(rpc: ActionRpc, input: DimaInboxRequest, ctx: DimaActionContext) {
    const target = dimaOptionsRequestSchema.parse(input)
    const methods = await availableMethods(rpc, target, ctx)
    const result = await sessionOptions(rpc, target, methods, ctx, true)
    this.reviewedModels.show(ctx, target, [...result.models ?? [], ...result.agents ?? []])
    return result
  }

  async act(rpc: ActionRpc, input: DimaActionRequest, ctx: DimaActionContext): Promise<DimaActionResult> {
    bounded(input)
    const req = dimaActionRequestSchema.parse(input)
    if (!ctx.owner || !ctx.instanceId) throw new RpcError('UNAUTHORIZED', 'An authenticated DimAgent device is required.')
    const target = targetOf(req)
    return this.receipts.once(ctx.owner, req.operationId, [ctx.instanceId, req], async () => {
      const methods = await availableMethods(rpc, target, ctx)
      if (!availableKinds(methods, target, ctx).includes(req.kind)) throw unsupported()
      const result: DimaActionResult = { ...target, operationId: req.operationId, kind: req.kind }
      switch (req.kind) {
        case 'answer': {
          const q = (await questions(rpc, target)).find(q => q.eventId === req.eventId && q.requestId === req.requestId && q.callId === req.callId)
          if (!q) throw stale()
          this.reviewed.require(ctx, target, q)
          const choice = validateAnswers(req, q)
          await mutation(async () => empty(await rpc.call('session.question.respond', { ...target, requestId: q.requestId, callId: q.callId, ...choice })))
          break
        }
        case 'steer': await submitSteer(rpc, req); break
        case 'retrieve': case 'withdraw': case 'steerQueued': {
          const held = (await heldInputs(rpc, target)).get(req.inputId)
          if (!held) throw new RpcError('DIMA_INPUT_NOT_HELD', 'This input is no longer held on the selected branch.')
          if (req.kind === 'retrieve' && !held.view.editable) throw stale()
          this.reviewed.require(ctx, target, held)
          const reply = await mutation(async () => {
            const response = record(await rpc.call('session.input.withdraw', { ...target, inputId: req.inputId,
              ...(req.kind === 'steerQueued' && { steer: held.user }) }))
            if (response.status !== 'deleted' && response.status !== 'notHeld') throw invalidReply()
            return response
          })
          if (reply.status === 'notHeld') throw new RpcError('DIMA_INPUT_NOT_HELD', 'This input is no longer held on the selected branch.')
          if (req.kind === 'retrieve') result.restoredText = held.view.text
          break
        }
        case 'branchCreate': {
          const directory = record(await rpc.call('session.branches', { sessionId: req.sessionId }))
          const branch = list(directory.branches, 8192).map(record).find(b => b.branchId === req.branchId)
          if (!branch || branch.state !== 'open') throw stale()
          const at = position(branch.head)
          result.newBranchId = await mutation(async () => {
            const created = record(record(await rpc.call('session.branch_create', { sessionId: req.sessionId, parentBranchId: req.branchId, at, prompt: req.text })).branch)
            if (created.parentBranchId !== req.branchId || created.branchPoint !== at || created.branchId === req.branchId) throw invalidReply()
            return id(created.branchId)
          })
          break
        }
        case 'fork': {
          let turn = finishAt(await rpc.call('session.turn.get', target), target)
          if (!turn.ended) turn = finishAt(await rpc.call('session.turn.get', { ...target, through: turn.sequence - 1 }), target)
          if (!turn.ended) throw stale()
          result.newSessionId = await mutation(async () => {
            const fork = record(await rpc.call('session.fork', { sessionId: req.sessionId, at: turn.sequence }))
            if (fork.sessionId === req.sessionId) throw invalidReply()
            position(fork.sequence)
            return id(fork.sessionId)
          })
          result.newBranchId = 'main'
          break
        }
        case 'endBranch': await mutation(async () => empty(await rpc.call('session.branch_end', target))); break
        case 'setDefault': await mutation(async () => {
          if (record(await rpc.call('session.branch_set_default', target)).defaultBranchId !== req.branchId) throw invalidReply()
        }); break
        case 'compact': {
          result.detail = await mutation(async () => {
            const reply = record(await rpc.call('session.context.compact', target))
            if (reply.status === 'completed') return 'completed'
            if (reply.status === 'skipped' && typeof reply.reason === 'string' && reply.reason.length <= 8183) return 'skipped: ' + reply.reason
            throw invalidReply()
          }); break
        }
        case 'rename': await mutation(async () => {
          const reply = record(await rpc.call('session.rename', { sessionId: req.sessionId, title: req.title }))
          if (reply.title !== req.title) throw invalidReply()
        }); break
        case 'setAgent': {
          const agents = await selectableAgents(rpc)
          const pick = agents.find(agent => agent.agentId === req.agentId)
          if (!pick) throw stale()
          this.reviewedModels.require(ctx, target, pick)
          await mutation(async () => {
            const reply = record(await rpc.call('session.agent.update', { ...target, agentId: pick.agentId }))
            if (!['adopted', 'unchanged'].includes(String(reply.outcome))) throw invalidReply()
          }); break
        }
        case 'setModel': case 'setEffort': {
          const options = await sessionOptions(rpc, target, methods, ctx, false)
          const pick = req.kind === 'setModel' ? req : options.model
          const selected = options.models?.find(m => m.provider === pick?.provider && m.modelId === pick.modelId)
          if (!selected || (req.kind === 'setEffort' && !selected.efforts.includes(req.effort))) throw stale()
          this.reviewedModels.require(ctx, target, selected)
          const change = req.kind === 'setModel' ? { providerId: selected.provider, modelId: selected.modelId } : { modelPreferences: { reasoningEffort: req.effort } }
          await mutation(async () => {
            const reply = record(await rpc.call('session.model.update', { ...target, ...change }))
            const model = record(reply.model)
            if (!['adopted', 'unchanged'].includes(String(reply.outcome)) || model.modelId !== selected.modelId) throw invalidReply()
            if (id(model.providerId) !== selected.provider) {
              // A temporary execution route can have a different logical catalog provider.
              const read = record(await rpc.call('session.model.get', target))
              const config = record(read.configuration), actual = record(config.model)
              if (read.branchId !== req.branchId || actual.providerId !== model.providerId || actual.modelId !== model.modelId ||
                config.catalogProviderId !== selected.provider) throw invalidReply()
            }
          }); break
        }
      }
      return dimaActionResultSchema.parse(result)
    })
  }
}
