import { z } from 'zod'
import { dimaCreateRequestSchema } from './dima.js'

export const dimaExtensionsRequestSchema = dimaCreateRequestSchema.pick({ cwd: true })
const text = z.string().min(1).max(8192).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const identity = z.object({
  kind: z.enum(['plugin', 'skill', 'mcp']), id: text, source: text, scope: z.enum(['host', 'workspace']),
}).strict()
const revision = z.string().regex(/^[0-9a-f]{64}$/u)
export const dimaExtensionSchema = identity.extend({
  name: text, enabled: z.boolean().nullable(), canToggle: z.boolean(), nativeToggleSupported: z.boolean().optional(), revision,
})
export const dimaExtensionsSchema = dimaExtensionsRequestSchema.extend({ items: z.array(dimaExtensionSchema).max(4096) })
export const dimaSetExtensionRequestSchema = dimaExtensionsRequestSchema.extend({
  ...identity.shape, revision, enabled: z.boolean(), operationId: z.uuid(),
})
export const dimaSetExtensionResultSchema = dimaExtensionsRequestSchema.extend({ operationId: z.uuid(), item: dimaExtensionSchema })
export const dimaExtensionsOperations = {
  extensions: { request: dimaExtensionsRequestSchema, result: dimaExtensionsSchema },
  setExtension: { request: dimaSetExtensionRequestSchema, result: dimaSetExtensionResultSchema },
} as const

export type DimaExtension = z.infer<typeof dimaExtensionSchema>
export type DimaExtensions = z.infer<typeof dimaExtensionsSchema>
export type DimaExtensionsRequest = z.infer<typeof dimaExtensionsRequestSchema>
export type DimaSetExtensionRequest = z.infer<typeof dimaSetExtensionRequestSchema>
export type DimaSetExtensionResult = z.infer<typeof dimaSetExtensionResultSchema>
