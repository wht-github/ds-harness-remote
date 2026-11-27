import {
  DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY, dimaCapabilities, dimaFeatures, dimaOperationMethod, dimaOperationTimeoutMs, isDimaOperation,
  parseDimaOperationRequest, parseDimaOperationResult, type DimaOperation,
  dimaCatalogSchema, dimaCreateRequestSchema, dimaCreateResultSchema, dimaHistoryQuerySchema, dimaHistoryRequestSchema, dimaHistorySchema,
  dimaRespondRequestSchema, dimaRespondResultSchema, dimaStatusSchema, dimaSubmitRequestSchema, dimaSubmitResultSchema,
} from '@dsh-remote/protocol'
import type { z } from 'zod'
import { ClientModeError, record, type ConnectedRemote, type HostAuthorizationControl } from './client-runtime-contract.js'

const endpoints = ['dima.probe', 'dima.interactionProbe', 'dima.features', 'dima.catalog', 'dima.history', 'dima.create', 'dima.submit', 'dima.status', 'dima.interrupt', 'dima.respond'] as const
type DimaEndpoint = typeof endpoints[number] | `dima.${DimaOperation}`
const readEndpoints = new Set<DimaEndpoint>([
  'dima.probe', 'dima.interactionProbe', 'dima.features', 'dima.catalog', 'dima.history', 'dima.status',
  'dima.timeline', 'dima.inbox', 'dima.options', 'dima.extensions', 'dima.mediaSearch', 'dima.mediaRead', 'dima.goal', 'dima.tasks', 'dima.taskDetail', 'dima.conversationExport',
])
export function isDimaEndpoint(endpoint: string): endpoint is DimaEndpoint {
  return endpoints.some(method => method === endpoint) || (endpoint.startsWith('dima.') && isDimaOperation(endpoint.slice(5)))
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ClientModeError('INVALID_MESSAGE', 'Invalid DimAgent request or response.')
  return result.data
}

export async function handleDimaControl(
  endpoint: DimaEndpoint,
  payload: unknown,
  signal: AbortSignal,
  host?: HostAuthorizationControl,
  activeRemote?: () => ConnectedRemote | undefined,
): Promise<unknown> {
  signal.throwIfAborted()
  const { target, targetDeviceId, ...args } = record(payload)
  if (target !== 'local' && target !== 'remote'
    || target === 'local' && targetDeviceId !== undefined
    || target === 'remote' && (typeof targetDeviceId !== 'string' || targetDeviceId.trim() === '')) {
    throw new ClientModeError('INVALID_MESSAGE', 'An explicit DimAgent source is required.')
  }
  const remote = target === 'remote' ? activeRemote?.() : undefined
  if (target === 'remote' && (remote === undefined || remote.target.deviceId !== targetDeviceId)) {
    throw new ClientModeError('REMOTE_NOT_CONNECTED', 'The selected DimAgent Host is disconnected.')
  }
  if ((endpoint === 'dima.probe' || endpoint === 'dima.interactionProbe' || endpoint === 'dima.features' || endpoint === 'dima.catalog') && Object.keys(args).length) {
    throw new ClientModeError('INVALID_MESSAGE', 'Unexpected DimAgent control arguments.')
  }
  function ensureCurrent(): void {
    const replaced = remote && (remote !== activeRemote?.() || remote.target.deviceId !== targetDeviceId)
    if ((replaced || signal.aborted) && !readEndpoints.has(endpoint)) {
      throw new ClientModeError('DIMA_OUTCOME_UNKNOWN', 'The DimAgent operation could not be confirmed. Refresh before acting again.')
    }
    signal.throwIfAborted()
    if (replaced) {
      throw new ClientModeError('REMOTE_NOT_CONNECTED', 'The selected DimAgent Host changed.')
    }
  }
  const remoteFeatures = () => {
    if (!remote?.features.dima) return dimaFeatures([])
    return remote.features.dimaFeatures ?? dimaFeatures([DIMA_CAPABILITY, ...(remote.features.dimaInteraction ? [DIMA_INTERACTION_CAPABILITY] : [])])
  }
  if (endpoint === 'dima.features') {
    if (remote) return remoteFeatures()
    if (host?.dimaFeatures) {
      const capabilities = dimaCapabilities(await host.dimaFeatures())
      ensureCurrent()
      return dimaFeatures(capabilities)
    }
    const [read, interaction] = await Promise.all([host?.dimaProbe?.(), host?.dimaInteractionProbe?.()])
    ensureCurrent()
    return dimaFeatures([...(read ? [DIMA_CAPABILITY] : []), ...(interaction ? [DIMA_INTERACTION_CAPABILITY] : [])])
  }
  const name = endpoint.slice('dima.'.length)
  if (isDimaOperation(name)) {
    if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'request')) throw new ClientModeError('INVALID_MESSAGE', 'Expected a single DimAgent request.')
    if (remote ? !remoteFeatures()[name] : !host?.dimaOperation) throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'The selected Host does not support this DimAgent operation.')
    let request
    try { request = parseDimaOperationRequest(name, args.request) }
    catch { throw new ClientModeError('INVALID_MESSAGE', 'Invalid DimAgent request.') }
    const method = dimaOperationMethod(name)
    const value = remote
      ? await remote.client.rpc(method, request, signal, dimaOperationTimeoutMs(method, request))
      : await host!.dimaOperation!(name, request, 'loopback', signal)
    // A rejection from the transport can describe an already-dispatched mutation. Preserve it.
    ensureCurrent()
    try { return parseDimaOperationResult(name, request, value) }
    catch { throw new ClientModeError('INVALID_MESSAGE', 'Invalid or unrelated DimAgent response.') }
  }
  if (endpoint === 'dima.probe') return remote ? remote.features.dima === true : await host?.dimaProbe?.() ?? false
  if (endpoint === 'dima.interactionProbe') return remote ? remote.features.dimaInteraction === true : await host?.dimaInteractionProbe?.() ?? false
  const needsInteraction = endpoint === 'dima.history' ? args.window === 'recent' : endpoint !== 'dima.catalog'
  if (remote && (!remote.features.dima || needsInteraction && !remote.features.dimaInteraction)) {
    throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'DimAgent does not support this operation on the selected Host.')
  }

  async function invoke<T>(method: string, request: object, local: (() => Promise<unknown>) | undefined, schema: z.ZodType<T>): Promise<T> {
    if (!remote && !local) throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'DimAgent is unavailable on the selected Host.')
    const value = remote ? await remote.client.rpc(method, request, signal) : await local!()
    ensureCurrent()
    const result = parse(schema, value)
    for (const key of ['cwd', 'sessionId', 'branchId', 'requestId'] as const) {
      if (Object.hasOwn(request, key) && Object.hasOwn(result as object, key) && record(request)[key] !== record(result)[key]) {
        throw new ClientModeError('INVALID_MESSAGE', 'DimAgent returned a response for another operation.')
      }
    }
    return result
  }

  switch (endpoint) {
    case 'dima.catalog':
      return invoke('dima.app.catalog', {}, host?.dimaCatalog?.bind(host), dimaCatalogSchema)
    case 'dima.create': {
      const input = parse(dimaCreateRequestSchema, args)
      return invoke('dima.app.create', input, host?.dimaCreate?.bind(host, input), dimaCreateResultSchema)
    }
    case 'dima.history': {
      const input = parse(dimaHistoryQuerySchema, args)
      return invoke('dima.app.history', input, host?.dimaHistory?.bind(host, input, signal), dimaHistorySchema)
    }
    case 'dima.respond': {
      const input = parse(dimaRespondRequestSchema, args)
      return invoke('dima.app.respond', input, host?.dimaRespond?.bind(host, input), dimaRespondResultSchema)
    }
    case 'dima.submit': {
      const input = parse(dimaSubmitRequestSchema, args)
      return invoke('dima.app.submit', input, host?.dimaSubmit?.bind(host, input), dimaSubmitResultSchema)
    }
    case 'dima.status':
    case 'dima.interrupt': {
      const input = parse(dimaHistoryRequestSchema, args)
      if (endpoint === 'dima.status') return invoke('dima.app.status', input, host?.dimaStatus?.bind(host, input, 'loopback', signal), dimaStatusSchema)
      return invoke('dima.app.interrupt', input, host?.dimaInterrupt?.bind(host, input), dimaHistoryRequestSchema)
    }
  }
}
