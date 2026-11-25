import { dimaCatalogSchema, dimaHistoryRequestSchema, dimaHistorySchema } from '@dsh-remote/protocol'
import { ClientModeError, record, type ConnectedRemote, type HostAuthorizationControl } from './client-runtime-contract.js'

type DimaEndpoint = 'dima.probe' | 'dima.catalog' | 'dima.history'

export function isDimaEndpoint(endpoint: string): endpoint is DimaEndpoint {
  return endpoint === 'dima.probe' || endpoint === 'dima.catalog' || endpoint === 'dima.history'
}

export async function readDimaControl(
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
  if (endpoint !== 'dima.history' && Object.keys(args).length > 0) {
    throw new ClientModeError('INVALID_MESSAGE', 'Unexpected DimAgent control arguments.')
  }
  if (endpoint === 'dima.probe') {
    return remote !== undefined ? remote.features.dima === true : await host?.dimaProbe?.() ?? false
  }
  if (remote !== undefined ? !remote.features.dima : !host?.dimaCatalog || !host.dimaHistory) {
    throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'DimAgent is unavailable on the selected Host.')
  }
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (remote !== undefined && remote !== activeRemote?.()) {
      throw new ClientModeError('REMOTE_NOT_CONNECTED', 'The selected DimAgent Host changed.')
    }
  }
  if (endpoint === 'dima.catalog') {
    const value = remote !== undefined ? await remote.client.rpc('dima.app.catalog', {}, signal) : await host!.dimaCatalog!()
    assertCurrent()
    const catalog = dimaCatalogSchema.safeParse(value)
    if (!catalog.success) throw new ClientModeError('INVALID_MESSAGE', 'Invalid DimAgent catalog.')
    return catalog.data
  }
  const request = dimaHistoryRequestSchema.safeParse(args)
  if (!request.success) throw new ClientModeError('INVALID_MESSAGE', 'A DimAgent session and branch are required.')
  const value = remote !== undefined ? await remote.client.rpc('dima.app.history', request.data, signal) : await host!.dimaHistory!(request.data)
  assertCurrent()
  const history = dimaHistorySchema.safeParse(value)
  if (!history.success || history.data.sessionId !== request.data.sessionId || history.data.branchId !== request.data.branchId) {
    throw new ClientModeError('INVALID_MESSAGE', 'Invalid history for the selected DimAgent branch.')
  }
  return history.data
}
