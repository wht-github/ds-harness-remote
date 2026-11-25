import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClientCore } from '@dsh-remote/client-core'
import { createNoisePrologue, NoiseIkSession } from '@dsh-remote/crypto'
import { DIMA_CAPABILITY, DIMA_WORKSPACE_TYPE, dimaCatalogSchema, dimaHistorySchema, type DimaHistory } from '@dsh-remote/protocol'
import type { SecureHandshakeTransport } from '@dsh-remote/webrtc'
import { afterEach, expect, inject, it, vi } from 'vitest'
import { ClientConnection } from '../src/client-connection.js'
import { ClientModeRuntime, probeRemoteHostFeatures } from '../src/client-runtime.js'
import type { ConnectedRemote } from '../src/client-runtime-contract.js'
import { ClientSecureTransport } from '../src/client-secure-transport.js'
import { resolveConfig } from '../src/config.js'
import { CONTROL_RPC_PREFIX } from '../src/control-route.js'
import { PluginControlRuntime } from '../src/control-runtime.js'
import type { ControlResult } from '../src/control-result.js'
import { unwrapControlResult } from '../src/client/control-result.js'
import { DimaAppServer } from '../src/dima/app-server.js'
import { RpcError } from '../src/safe-error.js'
import { IdentityStore } from '../src/identity-store.js'
import { SafeLogger } from '../src/logging.js'
import type { ClientServerApi } from '../src/server-api.js'
import { ServerNoiseChannel } from '../src/server-connection.js'
import { HostPluginRuntime } from '../src/service.js'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'

// An external smoke runner can supply a seeded, isolated native daemon through Vitest's provide option.
declare module 'vitest' {
  interface ProvidedContext {
    dimaFixture?: { home: string; cwd: string; sessionId: string; branchId: string }
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Dima fixture cleanup failed')
})

async function loopback(runtime: PluginControlRuntime) {
  const server = createServer()
  const unregister = runtime.register({ rpc: { handle: vi.fn() } }, {
    register(route) {
      expect(route).toMatchObject({ path: CONTROL_RPC_PREFIX, auth: 'required' })
      server.on('request', (req, res) => { void route.handler(req, res, { principal: { kind: 'owner' } }) })
      return () => { server.removeAllListeners('request') }
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    await unregister()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP port')
  return async (method: string, payload: unknown): Promise<unknown> => {
    const rpcId = randomUUID()
    const response = await fetch(`http://127.0.0.1:${address.port}${CONTROL_RPC_PREFIX}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { type: string; rpcId: string; result: ControlResult<unknown> }
    expect(body).toMatchObject({ type: 'server-response', rpcId })
    return unwrapControlResult(body.result, 'Dima loopback request failed')
  }
}

async function authenticatedPeer(host: HostPluginRuntime, hostStore: IdentityStore, clientStore: IdentityStore) {
  const hostId = host.currentIdentity()
  const clientId = await clientStore.loadOrCreate('Test client')
  const connectionId = randomUUID()
  const membershipId = randomUUID()
  const peer = await hostStore.trustPeer({ deviceId: clientId.deviceId, publicKey: clientId.publicKey, name: clientId.name, platform: 'desktop', membershipId })
  const target = await clientStore.trustPeer({ deviceId: hostId.deviceId, publicKey: hostId.publicKey, name: hostId.name, platform: 'desktop', membershipId })
  const noise = new NoiseIkSession({
    role: 'responder', localPrivateKey: hostId.privateKey, localPublicKey: hostId.publicKey, remotePublicKey: peer.publicKey,
    prologue: createNoisePrologue(connectionId, target.deviceId, peer.deviceId),
  })
  let receive: ((data: Uint8Array) => void) | undefined
  let handshake: ((step: number, data: Uint8Array) => void) | undefined
  const channel = new ServerNoiseChannel({ connectionId, membershipId, noise, peer, preferredTransports: ['relay'], transport: 'relay' },
    async data => receive?.(data), async () => undefined, 'Relay')
  const wire: SecureHandshakeTransport = {
    connect: async () => {}, close: async () => channel.close(), getStats: () => ({ connected: true, mode: 'Relay' }),
    connectionInfo: () => ({ connectionId, localDeviceId: peer.deviceId, remoteDeviceId: target.deviceId }),
    onMessage: handler => { receive = handler; return () => { receive = undefined } },
    onHandshake: handler => { handshake = handler; return () => { handshake = undefined } },
    sendHandshake: async (step, data) => {
      expect(step).toBe(1)
      noise.readHandshake(data)
      const response = noise.writeHandshake()
      await host.acceptAuthenticatedPeer(channel)
      handshake?.(2, response)
    },
    send: async data => channel.receive(undefined, data),
  }
  const client = new RemoteClientCore(new ClientSecureTransport(wire, clientId, target))
  cleanup.push(() => client.close())
  await client.connect()
  return { client, target, features: await probeRemoteHostFeatures(client) }
}

function prepareHistory(cwd: string) {
  const sessionId = 'sample-session'
  const branchId = 'sample-branch'
  vi.spyOn(DimaAppServer.prototype, 'probe').mockResolvedValue(true)
  vi.spyOn(DimaAppServer.prototype, 'catalog').mockResolvedValue({ workspaces: [{ cwd, sessions: [{ sessionId, title: 'Fixture', branches: ['main', branchId] }] }] })
  vi.spyOn(DimaAppServer.prototype, 'history').mockImplementation(async request => {
    if (request.sessionId !== sessionId || !['main', branchId].includes(request.branchId)) throw new RpcError('DIMA_NOT_FOUND', 'Unknown fixture branch')
    const text = request.branchId === 'main' ? 'main fixture' : 'branch fixture'
    return { ...request, messages: [{ role: 'user', text }, { role: 'assistant', text: 'Echo: ' + text }], truncated: false }
  })
  return { cwd, sessionId, branchId }
}

it('reads the selected DimAgent branch through owner loopback and an authenticated Host connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dima-integration-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const native = inject('dimaFixture')
  vi.stubEnv('DIMCODE_HOME', native?.home ?? join(directory, 'dimcode'))
  const fixture = native ?? prepareHistory(join(directory, 'workspace'))
  const config = resolveConfig({ acp: { enabled: false }, hostControl: { enabled: false } }, {})
  const logger = new SafeLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  const hostStore = new IdentityStore({ directory: join(directory, 'host') })
  const clientStore = new IdentityStore({ directory: join(directory, 'client') })
  const host = new HostPluginRuntime(config, hostStore, logger)
  cleanup.push(() => host.close())
  await host.start()
  const hostOnly = await loopback(new PluginControlRuntime(config, hostStore.directory, undefined, undefined, host))
  const runtime = new ClientModeRuntime(config, clientStore, { bindIdentity: vi.fn() } as unknown as ClientServerApi, { invoke: vi.fn() }, logger, host)
  cleanup.push(() => runtime.close())
  await runtime.start()
  const desktop = await loopback(new PluginControlRuntime(config, clientStore.directory, undefined, runtime, host))
  const peer = await authenticatedPeer(host, hostStore, clientStore)
  expect(peer.features).toMatchObject({ dima: true, remoteGateway: false,
    workspaceTypes: [{ id: DIMA_WORKSPACE_TYPE, available: true, capability: DIMA_CAPABILITY }],
  })
  // Device discovery is outside this fixture. The real Client runtime selects the negotiated peer.
  vi.spyOn(ClientConnection.prototype, 'connect').mockResolvedValue({ ...peer, progressRunId: 1 } as ConnectedRemote)
  const targetDeviceId = peer.target.deviceId
  const remote = { target: 'remote', targetDeviceId }
  const local = { target: 'local' }
  const request = { sessionId: fixture.sessionId, branchId: fixture.branchId }
  const calls = vi.spyOn(peer.client, 'rpc')
  expect(await desktop('workspaces.list', { targetDeviceId })).toEqual([])
  expect(await runtime.discoverToolWorkspaces(targetDeviceId, new AbortController().signal)).toEqual({ workspaces: [], unavailable: [] })
  expect(calls).not.toHaveBeenCalled()
  for (const [control, source] of [[hostOnly, local], [desktop, local], [desktop, remote]] as const) {
    expect(await control('dima.probe', source)).toBe(true)
    const catalog = dimaCatalogSchema.parse(await control('dima.catalog', source))
    const workspace = catalog.workspaces.find(row => row.cwd === fixture.cwd)
    expect(workspace?.sessions.find(row => row.sessionId === fixture.sessionId)?.branches).toEqual(['main', fixture.branchId])
    const history = dimaHistorySchema.parse(await control('dima.history', { ...source, ...request }))
    expect(history).toEqual({ ...request, truncated: false, messages: [
      { role: 'user', text: 'branch fixture' }, { role: 'assistant', text: 'Echo: branch fixture' },
    ] })
    const main = dimaHistorySchema.parse(await control('dima.history', { ...source, ...request, branchId: 'main' }))
    expect(main.messages).toContainEqual({ role: 'assistant', text: 'Echo: main fixture' })
    expect(main.messages).not.toContainEqual({ role: 'assistant', text: 'Echo: branch fixture' })
  }
  expect(calls.mock.calls.map(([method]) => method)).toEqual(['dima.app.catalog', 'dima.app.history', 'dima.app.history'])
  calls.mockClear()
  const invalidRequests = [
    ['absent source', 'dima.probe', {}, 'INVALID_MESSAGE'],
    ['unknown source', 'dima.catalog', { target: 'other' }, 'INVALID_MESSAGE'],
    ['local with device', 'dima.history', { ...request, ...local, targetDeviceId }, 'INVALID_MESSAGE'],
    ['remote missing device', 'dima.catalog', { target: 'remote' }, 'INVALID_MESSAGE'],
    ['different Host', 'dima.history', { ...request, ...remote, targetDeviceId: 'another-host' }, 'REMOTE_NOT_CONNECTED'],
    ['extra catalog argument', 'dima.catalog', { ...remote, cwd: fixture.cwd }, 'INVALID_MESSAGE'],
    ['empty branch', 'dima.history', { ...request, ...remote, branchId: '' }, 'INVALID_MESSAGE'],
    ['extra history argument', 'dima.history', { ...request, ...local, cwd: fixture.cwd }, 'INVALID_MESSAGE'],
  ] as const
  await runScenarios(invalidRequests.map(([name, method, payload, code]) => ({ name, run: async () => {
    await expect(desktop(method, payload)).rejects.toMatchObject({ code, details: { remoteCode: code } })
  } })))
  expect(calls).not.toHaveBeenCalled()
  await expect(peer.client.rpc('dima.app.catalog', { target: 'local' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  await expect(peer.client.rpc('dima.app.history', { sessionId: fixture.sessionId })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  await expect(hostOnly('dima.catalog', remote)).rejects.toMatchObject({ code: 'REMOTE_NOT_CONNECTED' })
  await expect(desktop('dima.history', { ...remote, ...request, branchId: 'missing-branch' })).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  const badHistory = vi.spyOn(host, 'dimaHistory')
  for (const source of [local, remote]) {
    badHistory.mockResolvedValueOnce({ ...request, branchId: 'main', messages: [], truncated: false })
    await expect(desktop('dima.history', { ...source, ...request })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    badHistory.mockResolvedValueOnce({ ...request, messages: [{ role: 'tool', text: 'unexpected' }], truncated: false } as unknown as DimaHistory)
    await expect(desktop('dima.history', { ...source, ...request })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  }
  badHistory.mockRestore()
  await host.setAgentBackends(resolveConfig({ acp: { enabled: false }, dima: { enabled: false } }, {}))
  expect(await hostOnly('dima.probe', local)).toBe(false)
  const description = await peer.client.rpc<{ capabilities: string[]; workspaceTypes: Array<{ id: string }> }>('harness.transport.describe', {})
  expect(description.capabilities).not.toContain(DIMA_CAPABILITY)
  expect(description.workspaceTypes.map(type => type.id)).not.toContain(DIMA_WORKSPACE_TYPE)
  await expect(peer.client.rpc('dima.app.history', request)).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })

  // Existing custom ACP registrations named "dima" use a separate workspace id and capability.
  const customAcp = { id: 'dima', name: 'dima', available: true, capability: 'agent.acp.dima.v1' }
  calls.mockResolvedValueOnce({ capabilities: [customAcp.capability], workspaceTypes: [customAcp] })
  const legacy = await probeRemoteHostFeatures(peer.client)
  expect(legacy.dima).toBeUndefined()
  expect(legacy.workspaceTypes).toContainEqual(customAcp)
  calls.mockResolvedValueOnce({ capabilities: [DIMA_CAPABILITY, customAcp.capability], workspaceTypes: [...peer.features.workspaceTypes!, customAcp] })
  const combined = await probeRemoteHostFeatures(peer.client)
  expect(combined.dima).toBe(true)
  expect(combined.workspaceTypes?.map(type => type.id)).toEqual([DIMA_WORKSPACE_TYPE, 'dima'])
}, 30_000)
