import { z } from 'zod'

export const DIMA_CAPABILITY = 'dima.appserver.v1'
export const DIMA_RPC_METHODS = ['dima.app.catalog', 'dima.app.history'] as const

const idSchema = z.string().min(1).max(512)
export const dimaHistoryRequestSchema = z.object({
  sessionId: idSchema,
  branchId: idSchema,
}).strict()

export const dimaCatalogSchema = z.object({
  workspaces: z.array(z.object({
    cwd: z.string().min(1).max(32_768),
    sessions: z.array(z.object({
      sessionId: idSchema,
      title: z.string().max(8192),
      branches: z.array(idSchema).max(8192),
    }).strict()).max(16_384),
  }).strict()).max(16_384),
}).strict()

export const dimaHistorySchema = dimaHistoryRequestSchema.extend({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  }).strict()).max(16_384),
  truncated: z.boolean(),
}).strict()

export type DimaCatalog = z.infer<typeof dimaCatalogSchema>
export type DimaHistoryRequest = z.infer<typeof dimaHistoryRequestSchema>
export type DimaHistory = z.infer<typeof dimaHistorySchema>
