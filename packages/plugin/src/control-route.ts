import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { MAX_SECURE_MESSAGE_BYTES } from '@dsh-remote/protocol'
import type { ControlResult } from './control-result.js'

/** Namespaced loopback RPC prefix shared by the Host runtime and browser UI. */
export const CONTROL_RPC_PREFIX = '/ds-harness-remote'

/** Loopback control endpoint carrying the status event stream. */
export const STATUS_STREAM_ENDPOINT = 'status.events'

/** Full URL path of the loopback status event stream. */
export const STATUS_STREAM_PATH = `${CONTROL_RPC_PREFIX}/${STATUS_STREAM_ENDPOINT}`

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const INVALID_REQUEST_RPC_ID = 'invalid-request'
class ControlBodyTooLarge extends Error {}

interface HostConnectionHandleLike {
  requestRejection?(request: { headers: IncomingHttpHeaders }): number | undefined
  admit?(request: { headers: IncomingHttpHeaders }): { rejection?: number; peer?: unknown } | undefined
  rpc: {
    handle?(
      channel: string,
      handler: ControlRouteHandler,
      options: { authority: 'loopback' | 'trusted-host' },
    ): () => Promise<void>
  }
}

export interface HostAdmittedPeerLike {
  readonly principal?: { readonly kind?: unknown } | string
  readonly signal?: { readonly aborted?: boolean }
}

export interface HostWebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    auth?: 'required'
    handler(req: IncomingMessage, res: ServerResponse, peer?: HostAdmittedPeerLike): void | Promise<void>
  }): () => void | Promise<void>
}

export type ControlRouteHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ControlResult<unknown>>

/** Long-lived loopback response owner for the status event stream. */
export interface ControlStatusStreamLike {
  handle(response: ServerResponse): Promise<void>
  close(): void
}

export function registerControlRoute(
  connection: HostConnectionHandleLike,
  handler: ControlRouteHandler,
  webServer?: HostWebServerLike,
  statusStream?: ControlStatusStreamLike,
): () => Promise<void> {
  if (webServer !== undefined) {
    // DSH 0.2.3+ authorizes `auth: 'required'` routes inside `webServer` and
    // hands the admitted Peer as the third handler argument; older hosts omit
    // the Peer and authorize through `connection.requestRejection` (or `admit`).
    const dispose = webServer.register({
      kind: 'prefix',
      path: CONTROL_RPC_PREFIX,
      auth: 'required',
      handler: (req, res, peer) => handleControlRequest(connection, handler, req, res, statusStream, peer),
    })
    return async () => {
      statusStream?.close()
      await dispose()
    }
  }

  // A plain RPC channel owns POST only, so the browser falls back to unary
  // status reads on hosts that do not expose the Web server route.
  const rpcHandle = connection.rpc.handle
  // Older or partially initialized carriers may expose neither the Web Server
  // route registry nor the legacy RPC helper.  Do not let that optional
  // compatibility path abort plugin activation and leave the UI stuck in
  // "control is still starting".
  if (rpcHandle === undefined) {
    console.warn('ds-harness-remote: local control unavailable (missing Web server and RPC route registries).')
    return async () => { statusStream?.close() }
  }
  return rpcHandle(CONTROL_RPC_PREFIX, handler, {
    authority: 'loopback',
  })
}

async function handleControlRequest(
  connection: HostConnectionHandleLike,
  handler: ControlRouteHandler,
  req: IncomingMessage,
  res: ServerResponse,
  statusStream?: ControlStatusStreamLike,
  admittedPeer?: HostAdmittedPeerLike,
): Promise<void> {
  const rejection = requestRejectionStatus(connection, req, admittedPeer)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'authentication unavailable' : 'forbidden')
    return
  }

  const endpoint = endpointFromPath(CONTROL_RPC_PREFIX, new URL(req.url ?? '/', 'http://dsh.internal').pathname)
  if (req.method === 'GET' && endpoint === STATUS_STREAM_ENDPOINT && statusStream !== undefined) {
    await statusStream.handle(res)
    return
  }
  if (req.method !== 'POST' || endpoint === undefined) {
    writeText(res, 404, 'not found')
    return
  }
  if (contentType(req.headers) !== 'application/json') {
    writeText(res, 415, 'content type must be application/json')
    return
  }

  const isDima = endpoint.startsWith('dima.')
  let body: unknown
  try {
    body = await readJsonBody(req, isDima ? MAX_SECURE_MESSAGE_BYTES : undefined)
  } catch (error) {
    if (error instanceof ControlBodyTooLarge) {
      // Drain in-flight bytes so a peer still uploading can receive its 413.
      req.resume()
      writeText(res, 413, 'DimAgent request body is too large')
      return
    }
    writeText(res, 400, 'body is not JSON')
    return
  }

  const message = clientRequest(body)
  if (message === undefined) {
    writeJson(res, 200, errorResponse(rpcId(body), {
      code: 'gateway/bad-request',
      message: 'invalid client-request message',
      details: { issues: [] },
    }))
    return
  }
  if (message.method !== endpoint) {
    writeJson(res, 200, errorResponse(message.rpcId, {
      code: 'gateway/bad-request',
      message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
      details: { issues: [] },
    }))
    return
  }

  const lifetime = isDima ? new AbortController() : undefined
  const onDisconnect = () => { if (!res.writableEnded) lifetime?.abort() }
  if (lifetime) {
    if (res.destroyed) return
    res.once('close', onDisconnect)
  }
  try {
    const result = await handler(endpoint, message.payload, lifetime?.signal ?? requestSignal(req))
    if (!lifetime?.signal.aborted) writeJson(res, 200, fullResponse(message.rpcId, result))
  } catch (error) {
    if (!lifetime?.signal.aborted) writeText(res, 500, `handler failure: ${String(error)}`)
  } finally {
    if (lifetime) res.off('close', onDisconnect)
  }
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function contentType(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers['content-type']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

async function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  if (maxBytes !== undefined && Number(req.headers['content-length']) > maxBytes) throw new ControlBodyTooLarge()
  const chunks: Buffer[] = []
  let bytes = 0
  // Keep the socket available for a 413 when a chunked upload crosses the limit.
  const source = maxBytes === undefined ? req : req.iterator({ destroyOnReturn: false })
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (maxBytes !== undefined && bytes > maxBytes) throw new ControlBodyTooLarge()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
}

function requestSignal(req: IncomingMessage): AbortSignal {
  const abort = new AbortController()
  req.on('close', () => {
    if (!req.complete) abort.abort()
  })
  return abort.signal
}

interface ClientRequestWire {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

function clientRequest(value: unknown): ClientRequestWire | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload }
}

function rpcId(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return INVALID_REQUEST_RPC_ID
  const record = value as Record<string, unknown>
  return typeof record.rpcId === 'string' ? record.rpcId : INVALID_REQUEST_RPC_ID
}

function errorResponse(rpcId: string, error: { code: string; message: string; details: Record<string, unknown> }): Record<string, unknown> {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: string, result: unknown): Record<string, unknown> {
  return { type: 'server-response', rpcId, result }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function requestRejectionStatus(
  connection: HostConnectionHandleLike,
  req: IncomingMessage,
  admittedPeer?: HostAdmittedPeerLike,
): number | undefined {
  if (typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) return normalizeRejectionStatus(rejection)
    return admittedPeer === undefined ? undefined : peerRejectionStatus(admittedPeer)
  }
  if (admittedPeer !== undefined) {
    return peerRejectionStatus(admittedPeer)
  }
  if (typeof connection.admit === 'function') {
    let admission: { rejection?: number; peer?: unknown } | undefined
    try {
      admission = connection.admit(req)
    } catch {
      return 503
    }
    if (typeof admission !== 'object' || admission === null) return 403
    if (typeof admission.rejection === 'number') return normalizeRejectionStatus(admission.rejection)
    return peerRejectionStatus(admission.peer)
  }
  return 403
}

function peerRejectionStatus(peer: unknown): number | undefined {
  if (typeof peer !== 'object' || peer === null) return 403
  const candidate = peer as HostAdmittedPeerLike
  if (candidate.signal?.aborted === true) return 401
  const principal = candidate.principal
  if (typeof principal === 'string') return principal === 'owner' ? undefined : 403
  if (typeof principal === 'object' && principal !== null) {
    return principal.kind === 'owner' ? undefined : 403
  }
  return 403
}

function normalizeRejectionStatus(code: unknown): number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 403
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status)
  res.end(body)
}
