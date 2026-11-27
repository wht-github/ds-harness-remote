import { describe, expect, it, vi } from 'vitest'
import { RemoteClientCore } from '@dsh-remote/client-core'
import {
  DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY, dimaCapabilities, dimaFeatures, dimaOperationCapability,
  createRpcResponse, decodeMessage, encodeMessage, dimaOperationNames, parseDimaOperationResult, type DimaOperationRequest,
} from '@dsh-remote/protocol'
import { probeRemoteHostFeatures } from '../src/client-capabilities.js'
import { handleDimaControl, isDimaEndpoint } from '../src/client-dima-control.js'
import type { ConnectedRemote, HostAuthorizationControl } from '../src/client-runtime-contract.js'
import type { ControlResult } from '../src/control-result.js'
import { PluginControlRuntime } from '../src/control-runtime.js'
import { resolveConfig } from '../src/config.js'

const request = { sessionId: 'session', branchId: 'main' }
const history = { ...request, messages: [{ role: 'user', text: 'question' }], truncated: false }
const signal = new AbortController().signal
const remoteSource = { target: 'remote', targetDeviceId: 'peer' }

function connection(rpc: (...args: never[]) => Promise<unknown>): ConnectedRemote {
  return { client: { rpc }, target: { deviceId: 'peer' }, features: { dima: true } } as unknown as ConnectedRemote
}

describe('DimAgent control source and RPC correlation', () => {
  it('keeps standalone control local and rejects attempts to fall back across sources', async () => {
    const status = { ...request, running: false, stopping: false }
    const host = {
      dimaProbe: vi.fn(async () => true), dimaCatalog: vi.fn(async () => ({ workspaces: [] })),
      dimaHistory: vi.fn(async () => history), dimaStatus: vi.fn(async () => status),
    }
    const runtime = new PluginControlRuntime(resolveConfig({}), '', undefined, undefined, host as unknown as HostAuthorizationControl)
    let call!: (method: string, args: unknown, signal: AbortSignal) => Promise<ControlResult<unknown>>
    const dispose = runtime.register({ rpc: { handle: (_channel, next) => { call = next; return async () => undefined } } })
    try {
      await expect(call('dima.probe', { target: 'local' }, signal)).resolves.toEqual({ ok: true, value: true })
      await expect(call('dima.catalog', { target: 'local' }, signal)).resolves.toEqual({ ok: true, value: { workspaces: [] } })
      await expect(call('dima.history', { target: 'local', ...request }, signal)).resolves.toEqual({ ok: true, value: history })
      for (const payload of [request, { ...remoteSource, ...request }, { target: 'local', targetDeviceId: 'peer', ...request }]) {
        await expect(call('dima.history', payload, signal)).resolves.toMatchObject({ ok: false })
      }
      expect(host.dimaHistory).toHaveBeenCalledTimes(1)
      expect(host.dimaHistory).toHaveBeenCalledWith(request, signal)
      await expect(call('dima.status', { target: 'local', ...request }, signal)).resolves.toEqual({ ok: true, value: status })
      expect(host.dimaStatus).toHaveBeenCalledWith(request, 'loopback', signal)
    } finally { await dispose() }
  })

  it('binds remote history to its connection, session and branch', async () => {
    const rpc = vi.fn(async () => history)
    const peer = connection(rpc)
    let current: ConnectedRemote | undefined = peer
    const read = () => handleDimaControl('dima.history', { ...remoteSource, ...request }, signal, undefined, () => current)
    await expect(read()).resolves.toEqual(history)
    expect(rpc).toHaveBeenCalledWith('dima.app.history', request, signal)
    for (const wrong of [{ sessionId: 'other' }, { branchId: 'other' }]) {
      rpc.mockResolvedValueOnce({ ...history, ...wrong })
      await expect(read()).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    }
    rpc.mockImplementationOnce(async () => { current = connection(rpc); return history })
    await expect(read()).rejects.toMatchObject({ code: 'REMOTE_NOT_CONNECTED' })
    current = undefined
    await expect(read()).rejects.toMatchObject({ code: 'REMOTE_NOT_CONNECTED' })
  })

  it('never falls back or resubmits after a failed write and rejects an unrelated receipt', async () => {
    const id = 'e1e29bda-ba7f-4ce9-8f18-3c365e43d64b'
    const input = { ...remoteSource, ...request, requestId: id, text: 'check the current file' }
    const rpc = vi.fn(async () => ({ ...request, requestId: id }))
    const peer = connection(rpc)
    const local = vi.fn(async () => ({ ...request, requestId: id }))
    const submit = () => handleDimaControl('dima.submit', input, signal, { dimaSubmit: local } as unknown as HostAuthorizationControl, () => peer)
    await expect(submit()).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
    expect(rpc).not.toHaveBeenCalled()
    peer.features.dimaInteraction = true
    rpc.mockRejectedValueOnce(new Error('connection closed after dispatch'))
    await expect(submit()).rejects.toThrow('connection closed after dispatch')
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockResolvedValueOnce({ ...request, requestId: 'e1e29bda-ba7f-4ce9-8f18-3c365e43d64c' })
    await expect(submit()).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(local).not.toHaveBeenCalled()
  })

  it('discovers per-operation capabilities and synthesizes both old Host profiles without calling unavailable methods', async () => {
    const rpc = vi.fn(async () => ({}))
    const peer = connection(rpc)
    const features = () => handleDimaControl('dima.features', remoteSource, signal, undefined, () => peer)
    await expect(features()).resolves.toEqual(dimaFeatures([DIMA_CAPABILITY]))
    peer.features.dimaInteraction = true
    await expect(features()).resolves.toEqual(dimaFeatures([DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY]))
    const offered = [DIMA_CAPABILITY, dimaOperationCapability('timeline'), dimaOperationCapability('tasks')]
    peer.features.dimaFeatures = dimaFeatures(offered)
    expect(dimaCapabilities(peer.features.dimaFeatures).sort()).toEqual([...offered].sort())
    await expect(features()).resolves.toMatchObject({ read: true, timeline: true, tasks: true, taskStop: false })
    expect(dimaFeatures(offered.slice(1)).timeline).toBe(false)
    expect(dimaOperationNames.every(name => isDimaEndpoint(`dima.${name}`))).toBe(true)
    for (const endpoint of ['dima.call', 'dima.constructor', 'dima.__proto__', 'dima.plugin.install']) expect(isDimaEndpoint(endpoint)).toBe(false)
    await expect(handleDimaControl('dima.act', { ...remoteSource, request }, signal, undefined, () => peer)).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
    await expect(handleDimaControl('dima.timeline', { ...remoteSource, request, method: 'session.stop' }, signal, undefined, () => peer)).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps task identity separate from connection selection and rejects mismatched or retired receipts', async () => {
    const input: DimaOperationRequest<'taskStop'> = { ...request, operationId: 'e1e29bda-ba7f-4ce9-8f18-3c365e43d64b', target: { kind: 'command', branchId: 'child', id: 'task-1' } }
    const rpc = vi.fn(async () => input)
    const peer = connection(rpc)
    peer.features.dimaFeatures = dimaFeatures([DIMA_CAPABILITY, dimaOperationCapability('taskStop')])
    let current = peer
    const stop = () => handleDimaControl('dima.taskStop', { ...remoteSource, request: input }, signal, undefined, () => current)
    await expect(stop()).resolves.toEqual(input)
    expect(rpc).toHaveBeenCalledWith('dima.app.taskStop', input, signal, undefined)
    rpc.mockResolvedValueOnce({ ...input, target: { ...input.target, branchId: 'other' } })
    await expect(stop()).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    rpc.mockImplementationOnce(async () => { current = connection(rpc); throw new Error('connection closed after dispatch') })
    await expect(stop()).rejects.toThrow('connection closed after dispatch')
    current = peer
    rpc.mockImplementationOnce(async () => { current = connection(rpc); return input })
    await expect(stop()).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    expect(rpc).toHaveBeenCalledTimes(4)
  })

  it('waits for native compaction and rejects oversized answers before dispatch', async () => {
    const input = { ...request, operationId: 'e1e29bda-ba7f-4ce9-8f18-3c365e43d64b', kind: 'compact' }
    let receive: (data: Uint8Array) => void
    const send = vi.fn(async (requestBytes: Uint8Array) => {
      const response = createRpcResponse(decodeMessage(requestBytes).id, input)
      setTimeout(() => receive(encodeMessage(response)), 119_000)
    })
    const client = new RemoteClientCore({ send, connect: async () => {}, close: async () => {},
      onMessage(callback) { receive = callback; return () => {} }, getStats: () => { throw new Error('The test only sends a unary request.') } })
    const peer = connection(client.rpc.bind(client))
    peer.features.dimaFeatures = dimaFeatures([DIMA_CAPABILITY, dimaOperationCapability('act')])
    const act = (request: object) => handleDimaControl('dima.act', { ...remoteSource, request }, signal, undefined, () => peer)
    vi.useFakeTimers()
    try {
      await client.connect()
      const confirmed = expect(act(input)).resolves.toEqual(input)
      await vi.advanceTimersByTimeAsync(119_000)
      await confirmed
      const answer = { ...input, kind: 'answer', eventId: 'event', requestId: 'question', callId: 'call' }
      for (const [count, custom] of [[65, 'a'.repeat(65_536)], [4, '\u0001'.repeat(65_536)]] as const) {
        const answers = Array.from({ length: count }, (_, i) => ({ questionId: String(i), selected: [], custom }))
        await expect(act({ ...answer, answers })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
      }
      expect(send).toHaveBeenCalledTimes(1)
    } finally { await client.close(); vi.useRealTimers() }
  })

  it('reads image chunks only from the negotiated Host, attachment and exact offset', async () => {
    const input = { ...request, sequence: 7, fileId: '00000000-0000-4000-8000-000000000001', mediaType: 'image/png' as const, offset: 0 }
    const chunk = { ...input, data: 'YQ==', eof: false }
    const rpc = vi.fn(async () => chunk)
    const peer = connection(rpc)
    let current = peer
    const read = (fileId = input.fileId) => handleDimaControl('dima.mediaRead', { ...remoteSource, request: { ...input, fileId } }, signal, undefined, () => current)
    await expect(read()).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
    expect(rpc).not.toHaveBeenCalled()
    peer.features.dimaFeatures = dimaFeatures([DIMA_CAPABILITY, dimaOperationCapability('mediaRead')])
    await expect(read('image.png')).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    expect(rpc).not.toHaveBeenCalled()
    await expect(read()).resolves.toEqual(chunk)
    for (const wrong of [{ sequence: 8 }, { fileId: '00000000-0000-4000-8000-000000000002' }, { mediaType: 'image/jpeg' }, { offset: 65536 }]) {
      rpc.mockResolvedValueOnce({ ...chunk, ...wrong } as typeof chunk)
      await expect(read()).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    }
    rpc.mockImplementationOnce(async () => { current = connection(rpc); return chunk })
    await expect(read()).rejects.toMatchObject({ code: 'REMOTE_NOT_CONNECTED' })
    expect(rpc).toHaveBeenCalledTimes(6)
  })

  it('links native edits, media offsets, exports and history watermarks to the accepted operation', () => {
    const operationId = 'e1e29bda-ba7f-4ce9-8f18-3c365e43d64b'
    const timeline = { ...request, through: 20, from: 1, to: 6, instanceId: 'daemon', turns: [] }
    const cursor = { ...request, through: 20, before: 7, instanceId: 'daemon' }
    expect(parseDimaOperationResult('timeline', { ...request, cursor }, timeline)).toEqual(timeline)
    expect(() => parseDimaOperationResult('timeline', { ...request, cursor }, { ...timeline, through: 21 })).toThrow()
    const upload = { ...request, uploadId: operationId, kind: 'image' as const, offset: 0, totalBytes: 1, data: 'YQ==' }
    expect(() => parseDimaOperationResult('mediaUpload', upload, { ...request, uploadId: operationId, nextOffset: 1, complete: false })).toThrow()
    expect(() => parseDimaOperationResult('act', { ...request, operationId, kind: 'compact' }, { ...request, operationId, kind: 'endBranch' })).toThrow()
    expect(() => parseDimaOperationResult('conversationExport', { ...request, branchId: 'main', format: 'markdown' }, { ...request, format: 'json', text: '[]' })).toThrow()
    const grant: DimaOperationRequest<'setExtension'> = { cwd: '/project', operationId, kind: 'skill', id: 'test', source: 'project', scope: 'workspace', revision: 'b'.repeat(64), enabled: true }
    const item = { kind: grant.kind, id: 'other', source: grant.source, scope: grant.scope, name: 'other', revision: grant.revision, enabled: true, canToggle: true }
    expect(() => parseDimaOperationResult('setExtension', grant, { cwd: grant.cwd, operationId, item })).toThrow()
  })

  it('negotiates native DimAgent independently of a custom ACP adapter named dima', async () => {
    const acp = { id: 'dima', name: 'Custom', capability: 'agent.acp.dima.v1', available: true }
    const native = { id: 'dima.appserver', name: 'DimAgent', capability: DIMA_CAPABILITY, available: true }
    const probe = (workspaceTypes: typeof acp[]) => probeRemoteHostFeatures(connection(async () => ({
      capabilities: [DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY, acp.capability], workspaceTypes,
    })).client)
    await expect(probe([native, acp])).resolves.toMatchObject({ dima: true, dimaInteraction: true, workspaceTypes: [native, acp] })
    expect((await probe([acp])).dima).toBeFalsy()
    const legacy = await probeRemoteHostFeatures(connection(async () => ({
      capabilities: [DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY, dimaOperationCapability('act')],
    })).client)
    expect(legacy.dimaFeatures).toEqual(dimaFeatures([DIMA_CAPABILITY]))
    expect(legacy.dimaInteraction).toBeFalsy()
  })
})
