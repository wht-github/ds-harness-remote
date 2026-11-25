import { describe, expect, it, vi } from 'vitest'
import { DIMA_CAPABILITY } from '@dsh-remote/protocol'
import { probeRemoteHostFeatures } from '../src/client-capabilities.js'
import { readDimaControl } from '../src/client-dima-control.js'
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
    const host = { dimaProbe: vi.fn(async () => true), dimaCatalog: vi.fn(async () => ({ workspaces: [] })), dimaHistory: vi.fn(async () => history) }
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
      expect(host.dimaHistory).toHaveBeenCalledWith(request)
    } finally { await dispose() }
  })

  it('binds remote history to its connection, session and branch', async () => {
    const rpc = vi.fn(async () => history)
    const peer = connection(rpc)
    let current: ConnectedRemote | undefined = peer
    const read = () => readDimaControl('dima.history', { ...remoteSource, ...request }, signal, undefined, () => current)
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

  it('negotiates native DimAgent independently of a custom ACP adapter named dima', async () => {
    const acp = { id: 'dima', name: 'Custom', capability: 'agent.acp.dima.v1', available: true }
    const native = { id: 'dima.appserver', name: 'DimAgent', capability: DIMA_CAPABILITY, available: true }
    const probe = (workspaceTypes: typeof acp[]) => probeRemoteHostFeatures(connection(async () => ({
      capabilities: [DIMA_CAPABILITY, acp.capability], workspaceTypes,
    })).client)
    await expect(probe([native, acp])).resolves.toMatchObject({ dima: true, workspaceTypes: [native, acp] })
    expect((await probe([acp])).dima).toBeFalsy()
  })
})
