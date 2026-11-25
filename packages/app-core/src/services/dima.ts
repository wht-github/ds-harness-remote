import {
  dimaCatalogSchema, dimaHistoryRequestSchema, dimaHistorySchema,
  type DimaCatalog, type DimaHistory, type DimaHistoryRequest,
} from '@dsh-remote/protocol'
import { strings } from '../locales/i18n'

type DimaRpc = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>

export function createDimaReader(rpc: DimaRpc) {
  return {
    async catalog(signal: AbortSignal): Promise<DimaCatalog> {
      const result = dimaCatalogSchema.safeParse(await rpc('dima.app.catalog', {}, signal))
      if (!result.success) throw new Error(strings.dima.invalidResponse)
      return result.data
    },
    async history(request: DimaHistoryRequest, signal: AbortSignal): Promise<DimaHistory> {
      const params = dimaHistoryRequestSchema.parse(request)
      const result = dimaHistorySchema.safeParse(await rpc('dima.app.history', params, signal))
      if (!result.success || result.data.sessionId !== params.sessionId || result.data.branchId !== params.branchId) {
        throw new Error(strings.dima.invalidResponse)
      }
      return result.data
    },
  }
}
