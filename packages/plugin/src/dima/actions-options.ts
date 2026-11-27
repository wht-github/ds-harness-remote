import type { DimaInboxRequest, DimaSessionOptions } from '@dsh-remote/protocol'
import { dimaSessionOptionsSchema } from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { invalidReply, record, tooLarge } from './native-rpc.js'
import { bounded, id, list, position, type ActionRpc, type DimaActionContext } from './actions-state.js'

function tokenCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw invalidReply()
  return Math.round(value)
}

function offeredEfforts(capabilities: unknown, declaration: unknown): string[] {
  if (capabilities == null || record(capabilities).reasoning !== true || declaration == null) return []
  const reasoning = record(declaration)
  if (reasoning.supported !== true) return []
  const values = list(reasoning.effortOptions ?? [], 64).map(id)
  if (reasoning.off != null && !values.includes('none')) values.push('none')
  return values
}

async function selectableModels(rpc: ActionRpc): Promise<NonNullable<DimaSessionOptions['models']>> {
  const result: NonNullable<DimaSessionOptions['models']> = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let after: { providerId: string; modelId: string } | undefined
  for (let i = 0; i < 16; i++) {
    const page = record(await rpc.call('provider.models.query', { selectableOnly: true, limit: 128, ...(after && { after }) }))
    const rows = list(page.models, 128)
    for (const entry of rows) {
      const row = record(entry), model = record(row.model)
      const provider = id(row.providerId), modelId = id(model.id)
      const key = JSON.stringify([provider, modelId])
      if (row.disabled === true || seen.has(key) || typeof model.name !== 'string' || !model.name || model.name.length > 4096) throw invalidReply()
      seen.add(key)
      if (model.unavailableReason != null) throw invalidReply()
      const reasoning = model.metadata == null ? undefined : record(model.metadata).reasoning
      result.push({ provider, modelId, label: model.name, efforts: offeredEfforts(model.capabilities, reasoning) })
    }
    if (page.next === null) return result
    const next = record(page.next)
    after = { providerId: id(next.providerId), modelId: id(next.modelId) }
    const cursor = JSON.stringify(after)
    if (!rows.length || cursors.has(cursor)) throw invalidReply()
    cursors.add(cursor)
  }
  throw tooLarge()
}

export async function selectableAgents(rpc: ActionRpc) {
  const seen = new Set<string>()
  return list(await rpc.call('agent.list', {}), 1024).map(value => {
    const row = record(value), agentId = id(row.agentId)
    if (seen.has(agentId) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 4096) throw invalidReply()
    seen.add(agentId)
    return { agentId, label: row.name }
  })
}

export async function sessionOptions(rpc: ActionRpc, target: DimaInboxRequest, methods: Set<string>, ctx: DimaActionContext, withUsage: boolean) {
  const result: DimaSessionOptions = { ...target }
  let efforts: string[] | undefined
  if (methods.has('session.model.get')) {
    const reply = record(await rpc.call('session.model.get', target))
    if (reply.branchId !== target.branchId) throw invalidReply()
    position(reply.through)
    if (reply.configuration !== null) {
      const config = record(reply.configuration), model = record(config.model)
      const provider = id(model.providerId), modelId = id(model.modelId)
      result.model = { provider: id(config.catalogProviderId ?? provider), modelId }
      if (config.modelPreferences != null) {
        const preference = record(config.modelPreferences).reasoningEffort
        if (preference != null) result.effort = id(preference)
      }
      if (config.capabilitySnapshot != null) {
        const snapshot = record(config.capabilitySnapshot), bound = record(snapshot.target)
        if (bound.providerId !== provider || bound.modelId !== modelId) throw invalidReply()
        efforts = offeredEfforts(snapshot.capabilities, snapshot.reasoning)
      }
    }
  }
  if (ctx.state === 'open') {
    if (methods.has('session.model.update') && methods.has('provider.models.query')) {
      result.models = await selectableModels(rpc)
      const current = result.models.find(model => model.provider === result.model?.provider && model.modelId === result.model.modelId)
      // Older adopted configurations carry no capability snapshot. Their current catalog row supplies its declaration.
      if (current && efforts) current.efforts = efforts
    }
    if (withUsage && methods.has('session.agent.update') && methods.has('agent.list')) result.agents = await selectableAgents(rpc)
    if (withUsage && methods.has('session.context.usage')) {
      // A new branch may have no usage estimate until its first context has been prepared.
      let usage: Record<string, unknown> | undefined
      try { usage = record(await rpc.call('session.context.usage', target)) } catch (error) {
        if (!(error instanceof RpcError && error.code === 'DIMA_USAGE_UNAVAILABLE')) throw error
      }
      if (usage) result.usage = { contextWindow: tokenCount(usage.contextWindow), estimatedInputTokens: tokenCount(usage.estimatedInputTokens),
        thresholdTokens: tokenCount(usage.thresholdTokens), outputTokens: tokenCount(usage.outputTokens) }
    }
  }
  bounded(result)
  const parsed = dimaSessionOptionsSchema.safeParse(result)
  if (!parsed.success) throw invalidReply()
  return parsed.data
}
