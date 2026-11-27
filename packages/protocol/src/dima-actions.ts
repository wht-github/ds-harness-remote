import { z } from 'zod'
import { dimaHistoryRequestSchema, DIMA_MAX_PROMPT_CHARS } from './dima.js'

const id = dimaHistoryRequestSchema.shape.branchId
const text = z.string().min(1).max(DIMA_MAX_PROMPT_CHARS)
const prompt = text.refine(value => value.trim().length > 0)
const label = z.string().min(1).max(4096)
const count = z.number().int().nonnegative().safe()
const question = z.object({
  id, header: z.string().max(80).optional(), question: text,
  options: z.array(z.object({ label, description: z.string().max(DIMA_MAX_PROMPT_CHARS).optional() }).strict()).min(2).max(6),
  multiSelect: z.boolean(), allowCustom: z.boolean(),
}).strict()
const pending = z.object({ eventId: id, requestId: id, callId: id, questions: z.array(question).min(1).max(4) }).strict()
const input = z.object({ inputId: id, mode: z.enum(['queue', 'steer']), text: z.string().max(DIMA_MAX_PROMPT_CHARS), editable: z.boolean() }).strict()
const kinds = ['answer', 'steer', 'withdraw', 'retrieve', 'steerQueued', 'branchCreate', 'fork', 'setDefault', 'endBranch', 'compact', 'setModel', 'setEffort', 'setAgent', 'rename'] as const
const kind = z.enum(kinds)
export type DimaActionKind = z.infer<typeof kind>
export const dimaInboxRequestSchema = dimaHistoryRequestSchema.pick({ sessionId: true, branchId: true })
export const dimaInboxSchema = dimaInboxRequestSchema.extend({ actions: z.array(kind).max(kinds.length), questions: z.array(pending).max(256), queue: z.array(input).max(512),
  media: z.object({ image: z.boolean(), paste: z.boolean(), file: z.boolean() }).strict().optional(),
})
export const dimaOptionsRequestSchema = dimaInboxRequestSchema
const model = z.object({ provider: id, modelId: id }).strict()
export const dimaSessionOptionsSchema = dimaOptionsRequestSchema.extend({
  model: model.optional(), effort: id.optional(), models: z.array(model.extend({ label, efforts: z.array(id).max(64) })).max(2048).optional(),
  agents: z.array(z.object({ agentId: id, label }).strict()).max(1024).optional(),
  usage: z.object({ contextWindow: count, outputTokens: count, thresholdTokens: count, estimatedInputTokens: count }).strict().optional(),
})
const operation = dimaInboxRequestSchema.extend({ operationId: z.uuid() })
const identity = { eventId: id, requestId: id, callId: id }
const answer = z.object({ questionId: id, selected: z.array(label).max(6), custom: text.optional() }).strict()
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const dimaActionRequestSchema = z.discriminatedUnion('kind', [
  operation.extend({ kind: z.literal('answer'), ...identity, answers: z.array(answer).min(1).max(4).optional(), declined: z.literal(true).optional() })
    .refine(v => (v.answers !== undefined) !== (v.declined === true))
    .refine(v => {
      if (!v.answers) return true
      let bytes = jsonBytes({ ...v, answers: [] }) + v.answers.length - 1
      return v.answers.every(row => (bytes += jsonBytes(row)) <= 1024 * 1024)
    }, 'The native answer exceeds the supported byte budget.'),
  operation.extend({ kind: z.literal('steer'), text: prompt }),
  operation.extend({ kind: z.literal('withdraw'), inputId: id }),
  operation.extend({ kind: z.literal('retrieve'), inputId: id }),
  operation.extend({ kind: z.literal('steerQueued'), inputId: id }),
  operation.extend({ kind: z.literal('branchCreate'), text: prompt }),
  operation.extend({ kind: z.literal('fork') }), operation.extend({ kind: z.literal('setDefault') }),
  operation.extend({ kind: z.literal('endBranch') }), operation.extend({ kind: z.literal('compact') }),
  operation.extend({ kind: z.literal('setModel'), provider: id, modelId: id }),
  operation.extend({ kind: z.literal('setEffort'), effort: id }),
  operation.extend({ kind: z.literal('setAgent'), agentId: id }),
  operation.extend({ kind: z.literal('rename'), title: z.string().trim().min(1).max(8192).nullable() }),
])
export const dimaActionResultSchema = operation.extend({
  kind, restoredText: text.optional(), newSessionId: id.optional(), newBranchId: id.optional(), detail: z.string().max(8192).optional(),
}).superRefine((v, ctx) => {
  if ((v.kind === 'retrieve') !== (v.restoredText !== undefined) || (v.kind === 'fork') !== (v.newSessionId !== undefined)
    || (v.kind === 'branchCreate' || v.kind === 'fork') !== (v.newBranchId !== undefined)) ctx.addIssue({ code: 'custom', message: 'Invalid result for this operation.' })
})
export const dimaActionsOperations = {
  inbox: { request: dimaInboxRequestSchema, result: dimaInboxSchema },
  options: { request: dimaOptionsRequestSchema, result: dimaSessionOptionsSchema },
  act: { request: dimaActionRequestSchema, result: dimaActionResultSchema },
} as const
export type DimaInboxRequest = z.infer<typeof dimaInboxRequestSchema>
export type DimaInbox = z.infer<typeof dimaInboxSchema>
export type DimaOptionsRequest = z.infer<typeof dimaOptionsRequestSchema>
export type DimaSessionOptions = z.infer<typeof dimaSessionOptionsSchema>
export type DimaActionRequest = z.infer<typeof dimaActionRequestSchema>
export type DimaActionResult = z.infer<typeof dimaActionResultSchema>
