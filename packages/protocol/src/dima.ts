import { z } from 'zod'

export const DIMA_CAPABILITY = 'dima.appserver.v1'
export const DIMA_MAX_PROMPT_CHARS = 64 * 1024
export const DIMA_INTERACTION_CAPABILITY = 'dima.appserver.interaction.v1'
export const DIMA_BASE_RPC_METHODS = [
  'dima.app.catalog', 'dima.app.history', 'dima.app.create', 'dima.app.submit', 'dima.app.status', 'dima.app.interrupt', 'dima.app.respond',
] as const

const idSchema = z.string().min(1).max(512).refine(id => !id.includes('\0'))
const cwdSchema = z.string().min(1).max(32_768).refine(path => !path.includes('\0'))
export const dimaHistoryRequestSchema = z.object({
  sessionId: idSchema,
  branchId: idSchema,
}).strict()

export const dimaCatalogSchema = z.object({
  workspaces: z.array(z.object({
    cwd: cwdSchema,
    sessions: z.array(z.object({
      sessionId: idSchema,
      title: z.string().max(8192),
      branches: z.array(idSchema).max(8192),
    }).strict()).max(16_384),
  }).strict()).max(16_384),
}).strict()

export const dimaHistoryQuerySchema = dimaHistoryRequestSchema.extend({ window: z.literal('recent').optional() })
export type DimaHistoryQuery = z.infer<typeof dimaHistoryQuerySchema>

export const dimaHistorySchema = dimaHistoryRequestSchema.extend({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  }).strict()).max(16_384),
  truncated: z.boolean(),
  lastTurnIssue: z.object({ status: z.enum(['failed', 'cancelled']), detail: z.string().max(2048) }).strict().optional(),
}).strict()

export const dimaCreateRequestSchema = z.object({ cwd: cwdSchema, requestId: z.uuid() }).strict()
export const dimaCreateResultSchema = dimaHistoryRequestSchema.extend({ cwd: cwdSchema })
export const dimaSubmitResultSchema = dimaHistoryRequestSchema.extend({ requestId: z.uuid() })
export const dimaSubmitRequestSchema = dimaSubmitResultSchema.extend({
  text: z.string().max(DIMA_MAX_PROMPT_CHARS).refine(text => text.trim().length > 0),
})
export const dimaApprovalSchema = z.object({
  requestId: idSchema, tool: z.string().min(1).max(512), reason: z.string().max(8192), input: z.string().max(32_768),
}).strict()
export const dimaStatusSchema = dimaHistoryRequestSchema.extend({
  running: z.boolean(), stopping: z.boolean(), approvals: z.array(dimaApprovalSchema).max(64).optional(),
})
export const dimaRespondResultSchema = dimaHistoryRequestSchema.extend({ requestId: idSchema })
export const dimaRespondRequestSchema = dimaRespondResultSchema.extend({ decision: z.enum(['allow', 'deny']) })

export type DimaApproval = z.infer<typeof dimaApprovalSchema>
export type DimaRespondRequest = z.infer<typeof dimaRespondRequestSchema>
export type DimaRespondResult = z.infer<typeof dimaRespondResultSchema>

export type DimaCreateRequest = z.infer<typeof dimaCreateRequestSchema>
export type DimaCreateResult = z.infer<typeof dimaCreateResultSchema>
export type DimaSubmitRequest = z.infer<typeof dimaSubmitRequestSchema>
export type DimaSubmitResult = z.infer<typeof dimaSubmitResultSchema>
export type DimaStatus = z.infer<typeof dimaStatusSchema>
export type DimaCatalog = z.infer<typeof dimaCatalogSchema>
export type DimaHistoryRequest = z.infer<typeof dimaHistoryRequestSchema>
export type DimaHistory = z.infer<typeof dimaHistorySchema>
