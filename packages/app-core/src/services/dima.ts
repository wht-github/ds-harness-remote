import {
  DIMA_MAX_PROMPT_CHARS, dimaOperations, parseDimaOperationResult, type DimaOperation, type DimaOperationRequest, type DimaOperationResult,
  dimaCatalogSchema, dimaCreateRequestSchema, dimaCreateResultSchema, dimaHistoryQuerySchema, dimaHistoryRequestSchema,
  dimaHistorySchema, dimaRespondRequestSchema, dimaRespondResultSchema, dimaStatusSchema, dimaSubmitRequestSchema, dimaSubmitResultSchema,
  type DimaCreateRequest, type DimaHistoryQuery, type DimaHistoryRequest, type DimaRespondRequest, type DimaSubmitRequest,
} from '@dsh-remote/protocol'
import { strings } from '../locales/i18n'

type DimaRpc = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
type ReplySchema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } }

function matchBranch<T extends DimaHistoryRequest>(request: DimaHistoryRequest, result: T): T {
  if (result.sessionId !== request.sessionId || result.branchId !== request.branchId) {
    throw new Error(strings.dima.invalidResponse)
  }
  return result
}

export type DimaClient = ReturnType<typeof createDimaClient>

/** Each recovered message becomes user-owned draft text before the next remote mutation. */
export async function stopWithDimaDraft(client: DimaClient, target: DimaHistoryRequest, draft: string, send: boolean,
  signal: AbortSignal, requestId: () => string, save: (value: string) => void) {
  const { queue, actions } = await client.operation('inbox', target, signal)
  if (queue.some(item => !item.editable) || !actions.includes('retrieve')) throw new Error(strings.dima.queueNotRecoverable)
  const combine = (rows: string[]) => [...rows, draft].filter(text => text.length > 0).join('\n')
  if (send && combine(queue.map(row => row.text)).length > DIMA_MAX_PROMPT_CHARS) throw new Error(strings.chat.draftTooLong(DIMA_MAX_PROMPT_CHARS))
  const recovered: string[] = []
  for (const item of queue) {
    try {
      const result = await client.operation('act', { ...target, kind: 'retrieve', inputId: item.inputId, operationId: requestId() }, signal)
      if (result.restoredText === undefined) throw new Error(strings.dima.invalidResponse)
      recovered.push(result.restoredText)
      save(combine(recovered))
    } catch (e) {
      const row = e as {code?: unknown; details?: {remoteCode?:unknown}} | null
      if (row?.code !== 'DIMA_INPUT_NOT_HELD' && row?.details?.remoteCode !== 'DIMA_INPUT_NOT_HELD') throw e
    }
  }
  await client.interrupt(target, signal)
  const text = combine(recovered)
  if (send && text.trim()) {
    await client.submit({ ...target, text, requestId: requestId() }, signal)
    save('')
  }
}

export function createDimaClient(rpc: DimaRpc, available: (interactive: boolean) => boolean, supports?: (op: DimaOperation) => boolean) {
  async function call<T>(method: string, params: unknown, signal: AbortSignal, schema: ReplySchema<T>, interactive: boolean) {
    const assertCurrent = () => {
      if (signal.aborted || !available(interactive)) throw new Error(strings.dima.unavailable)
    }
    assertCurrent()
    const reply = await rpc(method, params, signal)
    assertCurrent()
    const result = schema.safeParse(reply)
    if (!result.success) throw new Error(strings.dima.invalidResponse)
    return result.data
  }

  return {
    async operation<K extends DimaOperation>(key: K, request: DimaOperationRequest<K>, signal: AbortSignal): Promise<DimaOperationResult<K>> {
      const assertCurrent = () => {
        if (signal.aborted || !available(false) || !supports?.(key)) throw new Error(strings.dima.unavailable)
      }
      assertCurrent()
      const params = dimaOperations[key].request.parse(request) as DimaOperationRequest<K>
      const raw = await rpc('dima.app.' + key, params, signal)
      assertCurrent()
      return parseDimaOperationResult(key, params, raw)
    },
    catalog(signal: AbortSignal) {
      return call('dima.app.catalog', {}, signal, dimaCatalogSchema, false)
    },
    async history(request: DimaHistoryQuery, signal: AbortSignal) {
      const query = dimaHistoryQuerySchema.parse(request)
      return matchBranch(query, await call('dima.app.history', query, signal, dimaHistorySchema, query.window === 'recent'))
    },
    async create(request: DimaCreateRequest, signal: AbortSignal) {
      const params = dimaCreateRequestSchema.parse(request)
      const result = await call('dima.app.create', params, signal, dimaCreateResultSchema, true)
      if (result.cwd !== params.cwd) throw new Error(strings.dima.invalidResponse)
      return result
    },
    async submit(request: DimaSubmitRequest, signal: AbortSignal) {
      const params = dimaSubmitRequestSchema.parse(request)
      const result = matchBranch(params, await call('dima.app.submit', params, signal, dimaSubmitResultSchema, true))
      if (result.requestId !== params.requestId) throw new Error(strings.dima.invalidResponse)
      return result
    },
    async status(request: DimaHistoryRequest, signal: AbortSignal) {
      const params = dimaHistoryRequestSchema.parse(request)
      return matchBranch(params, await call('dima.app.status', params, signal, dimaStatusSchema, true))
    },
    async respond(request: DimaRespondRequest, signal: AbortSignal) {
      const params = dimaRespondRequestSchema.parse(request)
      const result = matchBranch(params, await call('dima.app.respond', params, signal, dimaRespondResultSchema, true))
      if (result.requestId !== params.requestId) throw new Error(strings.dima.invalidResponse)
      return result
    },
    async interrupt(request: DimaHistoryRequest, signal: AbortSignal) {
      const params = dimaHistoryRequestSchema.parse(request)
      return matchBranch(params, await call('dima.app.interrupt', params, signal, dimaHistoryRequestSchema, true))
    },
  }
}
