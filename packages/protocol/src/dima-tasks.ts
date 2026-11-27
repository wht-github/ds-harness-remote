import { z } from 'zod'
import { dimaHistoryRequestSchema as branch } from './dima.js'

const id = z.string().min(1).max(512).refine(value => !value.includes('\0'))
const objective = z.string().min(1).max(8_000).refine(value => !!value.trim() && [...value].length <= 4_000)
const operationId = z.uuid()
const goalState = z.object({
  objective, status: z.enum(['active', 'paused', 'completed', 'blocked', 'none']), reason: z.string().max(2048).optional(),
}).strict().nullable()
const goalRead = branch.extend({ goal: goalState })
const taskTarget = z.object({ kind: z.enum(['command', 'member', 'workflow']), branchId: id, id }).strict()
const specificTask = branch.extend({ target: taskTarget })
const update = branch.extend({ operationId })
const format = z.enum(['markdown', 'json'])
const exportRequest = branch.extend({ branchId: z.literal('main'), format })
const detailText = z.string().max(65_536)
export const dimaTasksOperations = {
  goal: { request: branch, result: goalRead },
  goalUpdate: {
    request: z.discriminatedUnion('action', [
      update.extend({ action: z.enum(['set', 'edit']), objective }),
      update.extend({ action: z.enum(['pause', 'resume', 'clear']) }),
    ]),
    result: goalRead.extend({ operationId }),
  },
  tasks: {
    request: branch,
    result: branch.extend({ sources: z.object({ commands: z.boolean(), members: z.boolean(), workflows: z.boolean() }).strict(),
      items: z.array(z.object({ target: taskTarget, label: z.string().max(2048), state: z.string().min(1).max(64), canStop: z.boolean() }).strict()).max(2048) }),
  },
  taskDetail: { request: specificTask, result: specificTask.extend({ text: detailText, truncated: z.boolean() }) },
  taskStop: { request: specificTask.extend({ operationId }), result: specificTask.extend({ operationId }) },
  conversationExport: { request: exportRequest, result: exportRequest.extend({ text: z.string().max(1_048_576) }) },
} as const

export type DimaTaskKey = keyof typeof dimaTasksOperations
export type DimaTaskRequest<K extends DimaTaskKey> = z.infer<(typeof dimaTasksOperations)[K]['request']>
export type DimaTaskResult<K extends DimaTaskKey> = z.infer<(typeof dimaTasksOperations)[K]['result']>
export type DimaTaskTarget = z.infer<typeof taskTarget>
