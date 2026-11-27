import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClientCore } from '@dsh-remote/client-core'
import { createNoisePrologue, NoiseIkSession } from '@dsh-remote/crypto'
import {
  DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY, dimaFeatures, dimaOperationCapability, dimaTimelineSchema, mergeDimaTimelinePages, dimaInboxSchema, dimaCatalogSchema, dimaCreateResultSchema, dimaHistorySchema, dimaStatusSchema,
  type DimaCreateRequest, type DimaHistory, type DimaHistoryQuery, type DimaHistoryRequest, type DimaRespondRequest, type DimaSubmitRequest,
} from '@dsh-remote/protocol'
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

async function authenticatedPeer(host: HostPluginRuntime, hostStore: IdentityStore, clientStore: IdentityStore, platform: 'desktop' | 'android' = 'desktop') {
  const hostId = host.currentIdentity()
  const clientId = await clientStore.loadOrCreate('Test client')
  const connectionId = randomUUID()
  const membershipId = randomUUID()
  const peer = await hostStore.trustPeer({ deviceId: clientId.deviceId, publicKey: clientId.publicKey, name: clientId.name, platform, membershipId })
  const target = await clientStore.trustPeer({ deviceId: hostId.deviceId, publicKey: hostId.publicKey, name: hostId.name, platform: 'desktop', membershipId })
  const noise = new NoiseIkSession({
    role: 'responder', localPrivateKey: hostId.privateKey, localPublicKey: hostId.publicKey, remotePublicKey: peer.publicKey,
    prologue: createNoisePrologue(connectionId, target.deviceId, peer.deviceId),
  })
  let receive: ((data: Uint8Array) => void) | undefined
  let handshake: ((step: number, data: Uint8Array) => void) | undefined
  const closeHandlers = new Set<(error?: Error) => void>()
  const transmit = vi.fn(async (ciphertext: Uint8Array) => receive?.(ciphertext))
  const channel = new ServerNoiseChannel({ connectionId, membershipId, noise, peer, preferredTransports: ['relay'], transport: 'relay' },
    transmit, async () => { for (const handler of closeHandlers) handler() }, 'Relay')
  const wire: SecureHandshakeTransport = {
    connect: async () => {}, close: async () => channel.close(), getStats: () => ({ connected: true, mode: 'Relay' }),
    connectionInfo: () => ({ connectionId, localDeviceId: peer.deviceId, remoteDeviceId: target.deviceId }),
    onMessage: handler => { receive = handler; return () => { receive = undefined } },
    onClose: handler => { closeHandlers.add(handler); return () => { closeHandlers.delete(handler) } },
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
  return { client, target, features: await probeRemoteHostFeatures(client), transport: wire as ConnectedRemote['transport'],
    loseNextReply: () => { transmit.mockImplementationOnce(async () => channel.close()) },
  }
}

const waitForInterrupt = 'tool:wait {"millis":60000}'

function prepareProvider(cwd: string) {
  const sessionId = 'sample-session'
  const branchId = 'sample-branch'
  const echo = (text: string): DimaHistory['messages'] => [{ role: 'user', text }, { role: 'assistant', text: 'Echo: ' + text }]
  const sessions = new Map([[sessionId, new Map([['main', echo('main fixture')], [branchId, echo('branch fixture')]])]])
  const messages = (request: DimaHistoryRequest) => {
    const branch = sessions.get(request.sessionId)?.get(request.branchId)
    if (!branch) throw new RpcError('DIMA_NOT_FOUND', 'Unknown fixture branch')
    return branch
  }
  const provider = DimaAppServer.prototype
  vi.spyOn(provider, 'probe').mockResolvedValue(true)
  vi.spyOn(provider, 'interactionAvailable').mockResolvedValue(true)
  vi.spyOn(provider, 'features').mockResolvedValue(dimaFeatures([DIMA_CAPABILITY, DIMA_INTERACTION_CAPABILITY,
    dimaOperationCapability('timeline'), dimaOperationCapability('inbox'), dimaOperationCapability('mediaRead')]))
  const image = { fileId: 'b41c45d1-7b43-4fbf-9da1-b18fcb73ec20', mediaType: 'image/png' as const }
  vi.spyOn(provider, 'mediaRead').mockImplementation(async request => {
    if (request.sessionId !== sessionId || request.branchId !== branchId || request.sequence !== 1
      || request.fileId !== image.fileId || request.mediaType !== image.mediaType || ![0, 8].includes(request.offset)) {
      throw new RpcError('DIMA_NOT_FOUND', 'Unknown fixture image')
    }
    return { ...request, data: request.offset === 0 ? 'iVBORw0KGgo=' : '', eof: request.offset === 8 }
  })
  vi.spyOn(provider, 'timeline').mockImplementation(async request => {
    const entries = messages(request)
    const target = { sessionId: request.sessionId, branchId: request.branchId }
    return { ...target, instanceId: 'test-daemon', from: 1, to: entries.length, through: entries.length,
      turns: [{ id: 'turn', sequence: 1, status: 'completed', blocks: entries.map((message, index) => ({
        id: String(index + 1), sequence: index + 1, kind: message.role === 'user' ? 'user' : 'text', text: message.text,
        ...(index === 0 && request.sessionId === sessionId && request.branchId === branchId && { attachments: [image] }),
      })) }] }
  })
  vi.spyOn(provider, 'inbox').mockImplementation(async request => {
    messages(request)
    return { ...request, actions: [], questions: [], queue: [] }
  })
  vi.spyOn(provider, 'catalog').mockImplementation(async () => ({ workspaces: [{ cwd, sessions: Array.from(sessions, ([sessionId, branches]) => ({ sessionId, title: 'Fixture', branches: [...branches.keys()] })) }] }))
  vi.spyOn(provider, 'history').mockImplementation(async request => ({
    sessionId: request.sessionId, branchId: request.branchId, messages: messages(request), truncated: false,
  }))
  const created = new Map<string, string>()
  vi.spyOn(provider, 'create').mockImplementation(async (request, owner) => {
    const key = owner + '/' + request.requestId
    let sessionId = created.get(key)
    if (!sessionId) {
      sessionId = randomUUID()
      sessions.set(sessionId, new Map([['main', []]]))
      created.set(key, sessionId)
    }
    return { cwd: request.cwd, sessionId, branchId: 'main' }
  })
  const running = new Set<string>()
  const branchKey = ({ sessionId, branchId }: DimaHistoryRequest) => JSON.stringify([sessionId, branchId])
  const submitted = new Map<string, DimaSubmitRequest>()
  vi.spyOn(provider, 'submit').mockImplementation(async (request, owner) => {
    const key = owner + '/' + request.requestId
    const previous = submitted.get(key)
    if (previous && (previous.text !== request.text || previous.sessionId !== request.sessionId || previous.branchId !== request.branchId)) {
      throw new RpcError('DIMA_REQUEST_CONFLICT', 'Conflicting fixture request')
    }
    if (!previous) {
      if (request.text === waitForInterrupt) {
        messages(request).push({ role: 'user', text: request.text })
        running.add(branchKey(request))
      } else messages(request).push(...echo(request.text))
      submitted.set(key, request)
    }
    return { sessionId: request.sessionId, branchId: request.branchId, requestId: request.requestId }
  })
  vi.spyOn(provider, 'status').mockImplementation(async request => {
    messages(request)
    return { ...request, running: running.has(branchKey(request)), stopping: false }
  })
  vi.spyOn(provider, 'interrupt').mockImplementation(async request => {
    if (!running.delete(branchKey(request))) throw new RpcError('DIMA_NOT_RUNNING', 'Fixture is idle')
    return request
  })
  vi.spyOn(provider, 'respond').mockRejectedValue(new RpcError('DIMA_APPROVAL_STALE', 'No pending fixture approval'))
  return { cwd, sessionId, branchId }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dima-integration-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const native = inject('dimaFixture')
  vi.stubEnv('DIMCODE_HOME', native?.home ?? join(directory, 'dimcode'))
  const fixture = native ?? prepareProvider(join(directory, 'workspace'))
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
    workspaceTypes: [{ id: 'dima.appserver', available: true, capability: DIMA_CAPABILITY }],
  })
  // Device discovery is outside this fixture. The real Client runtime selects the negotiated peer.
  const selected: ConnectedRemote = { ...peer, progressRunId: 1 }
  vi.spyOn(ClientConnection.prototype, 'connect').mockResolvedValue(selected)
  const targetDeviceId = peer.target.deviceId
  const remote = { target: 'remote', targetDeviceId }
  const local = { target: 'local' }
  // Resolving the device through the desktop entry point establishes its active remote.
  const calls = vi.spyOn(peer.client, 'rpc')
  expect(await desktop('workspaces.list', { targetDeviceId })).toEqual([])
  return { host, hostStore, directory, hostOnly, desktop, peer, selected, runtime, targetDeviceId, local, remote, calls, fixture }
}

it('reads the selected DimAgent branch through owner loopback and an authenticated Host connection', async () => {
  const { host, hostOnly, desktop, peer, runtime, targetDeviceId, local, remote, calls, fixture } = await setup()
  const request = { sessionId: fixture.sessionId, branchId: fixture.branchId }
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
  expect(description.workspaceTypes.map(type => type.id)).not.toContain('dima.appserver')
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
  expect(combined.workspaceTypes?.map(type => type.id)).toEqual(['dima.appserver', 'dima'])
}, 30_000)

function pcClient(control: Awaited<ReturnType<typeof loopback>>, source: { target: string; targetDeviceId?: string }) {
  const call = <T extends object>(method: string) => (args: T, _signal: AbortSignal) => control('dima.' + method, { ...source, ...args })
  return {
    create: call<DimaCreateRequest>('create'),
    submit: call<DimaSubmitRequest>('submit'),
    status: call<DimaHistoryRequest>('status'),
    history: call<DimaHistoryQuery>('history'),
    interrupt: call<DimaHistoryRequest>('interrupt'),
    respond: call<DimaRespondRequest>('respond'),
  }
}

it('runs native interactions through PC loopback and the encrypted PC and mobile RPC paths', async () => {
  const { host, hostStore, directory, hostOnly, desktop, peer, selected, local, remote, calls, fixture } = await setup()
  expect(peer.features.dimaInteraction).toBe(true)
  for (const [control, source] of [[hostOnly, local], [desktop, local], [desktop, remote]] as const) {
    expect(await control('dima.interactionProbe', source)).toBe(true)
  }
  // Load the mobile service through Vite, which resolves its Metro-style extensionless imports.
  const { createDimaClient } = await vi.importActual<{
    createDimaClient(rpc: RemoteClientCore['rpc'], available: (interactive: boolean) => boolean): ReturnType<typeof pcClient>
  }>('@dsh-remote/app-core/services/dima')
  const phone = await authenticatedPeer(host, hostStore, new IdentityStore({ directory: join(directory, 'phone') }), 'android')
  const mobileCalls = vi.spyOn(phone.client, 'rpc')
  const mobile = createDimaClient((method, params, signal) => phone.client.rpc(method, params, signal),
    interactive => interactive ? phone.features.dimaInteraction === true : phone.features.dima === true)
  const signal = new AbortController().signal
  const clients = [
    { name: 'standalone Host', api: pcClient(hostOnly, local), encrypted: false },
    { name: 'local PC', api: pcClient(desktop, local), encrypted: false },
    { name: 'remote PC', api: pcClient(desktop, remote), encrypted: true },
    { name: 'mobile RPC', api: mobile, encrypted: true, calls: mobileCalls },
  ]
  const createdIds = new Set<string>()
  await runScenarios(clients.map(({ name, api, encrypted, calls: routeCalls = calls }) => ({ name, run: async () => {
    routeCalls.mockClear()
    const create = { cwd: fixture.cwd, requestId: randomUUID() }
    const result = dimaCreateResultSchema.parse(await api.create(create, signal))
    expect(result.cwd).toBe(fixture.cwd)
    expect(createdIds.has(result.sessionId)).toBe(false)
    createdIds.add(result.sessionId)
    expect(await api.create(create, signal)).toEqual(result)
    const branch = { sessionId: result.sessionId, branchId: result.branchId }
    const text = name + ' fixture'
    const submit = { ...branch, requestId: randomUUID(), text }
    const receipt = { ...branch, requestId: submit.requestId }
    expect(await api.submit(submit, signal)).toEqual(receipt)
    expect(await api.submit(submit, signal)).toEqual(receipt)
    await expect(api.submit({ ...submit, text: 'conflicting fixture' }, signal)).rejects.toMatchObject({ code: 'DIMA_REQUEST_CONFLICT' })
    await vi.waitFor(async () => {
      const status = dimaStatusSchema.parse(await api.status(branch, signal))
      expect(status).toMatchObject({ ...branch, running: false, stopping: false })
      const history = dimaHistorySchema.parse(await api.history({ ...branch, window: 'recent' }, signal))
      expect(history).toEqual({ ...branch, truncated: false, messages: [{ role: 'user', text }, { role: 'assistant', text: 'Echo: ' + text }] })
    }, { timeout: 10_000, interval: 100 })
    await expect(api.interrupt(branch, signal)).rejects.toMatchObject({ code: 'DIMA_NOT_RUNNING' })
    await expect(api.respond({ ...branch, requestId: 'absent-approval', decision: 'deny' }, signal)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    const methods = routeCalls.mock.calls.map(([method]) => method)
    if (encrypted) {
      expect(methods.filter(method => method === 'dima.app.create')).toHaveLength(2)
      expect(methods.filter(method => method === 'dima.app.submit')).toHaveLength(3)
      expect(routeCalls.mock.calls.filter(([method]) => method === 'dima.app.history').map(([, query]) => query))
        .toContainEqual({ ...branch, window: 'recent' })
      expect(methods).toEqual(expect.arrayContaining(['dima.app.status', 'dima.app.history', 'dima.app.interrupt', 'dima.app.respond']))
    } else expect(methods).toEqual([])
  } })))

  const branch = { sessionId: fixture.sessionId, branchId: fixture.branchId }
  const main = { ...branch, branchId: 'main' }
  const initial = await mobile.history(main, signal)
  const invalid = { ...branch, branchId: 'missing-branch', requestId: randomUUID(), text: 'absent branch fixture' }
  calls.mockClear()
  for (const source of [{}, { ...local, targetDeviceId: remote.targetDeviceId }, { ...remote, targetDeviceId: 'wrong-host' }]) {
    const code = 'target' in source && source.target === 'remote' ? 'REMOTE_NOT_CONNECTED' : 'INVALID_MESSAGE'
    await expect(desktop('dima.submit', { ...source, ...invalid })).rejects.toMatchObject({ code, details: { remoteCode: code } })
  }
  expect(calls).not.toHaveBeenCalled()
  await expect(mobile.submit(invalid, signal)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  await expect(peer.client.rpc('dima.app.submit', { ...invalid, target: 'local' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })

  // Lose the acknowledgement after the native write. Recovery may read the branch but must not issue a second submission.
  const submitOnce = host.dimaSubmit.bind(host)
  const writes = vi.spyOn(host, 'dimaSubmit')
  for (const { name, api } of clients) {
    const text = name + ' lost acknowledgement fixture'
    const submit = { ...branch, requestId: randomUUID(), text }
    writes.mockClear().mockImplementationOnce(async (request, owner) => {
      await submitOnce(request, owner)
      throw new RpcError('DIMA_OUTCOME_UNKNOWN', 'Fixture acknowledgement lost')
    })
    await expect(api.submit(submit, signal)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    await vi.waitFor(async () => {
      const history = dimaHistorySchema.parse(await api.history({ ...branch, window: 'recent' }, signal))
      expect(history.messages.filter(message => message.text === text || message.text === 'Echo: ' + text)).toEqual([
        { role: 'user', text }, { role: 'assistant', text: 'Echo: ' + text },
      ])
    }, { timeout: 10_000, interval: 100 })
    expect(writes).toHaveBeenCalledTimes(1)
  }
  writes.mockRestore()

  // Observe and stop the PC's running child branch through the mobile RPC client.
  await desktop('dima.submit', { ...remote, ...branch, requestId: randomUUID(), text: waitForInterrupt })
  await vi.waitFor(async () => expect(await mobile.status(branch, signal)).toMatchObject({ ...branch, running: true }), { timeout: 10_000 })
  expect(await mobile.interrupt(branch, signal)).toEqual(branch)
  await vi.waitFor(async () => expect(await mobile.status(branch, signal)).toMatchObject({ ...branch, running: false }), { timeout: 10_000 })
  expect(await mobile.history(main, signal)).toEqual(initial)

  vi.spyOn(host, 'dimaInteractionProbe').mockResolvedValue(false)
  vi.spyOn(host, 'dimaFeatures').mockResolvedValue(dimaFeatures([DIMA_CAPABILITY]))
  const description = await peer.client.rpc<{ capabilities: string[] }>('harness.transport.describe', {})
  expect(description.capabilities).toContain(DIMA_CAPABILITY)
  expect(description.capabilities).not.toContain(DIMA_INTERACTION_CAPABILITY)
  selected.features = await probeRemoteHostFeatures(peer.client)
  phone.features = await probeRemoteHostFeatures(phone.client)
  expect(await desktop('dima.interactionProbe', local)).toBe(false)
  expect(await desktop('dima.interactionProbe', remote)).toBe(false)
  calls.mockClear()
  mobileCalls.mockClear()
  const create = { cwd: fixture.cwd, requestId: randomUUID() }
  await expect(desktop('dima.create', { ...remote, ...create })).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
  await expect(mobile.create(create, signal)).rejects.toThrow()
  const recent = { ...main, window: 'recent' } as const
  await expect(desktop('dima.history', { ...remote, ...recent })).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
  await expect(mobile.history(recent, signal)).rejects.toThrow()
  expect(calls).not.toHaveBeenCalled()
  expect(mobileCalls).not.toHaveBeenCalled()
  expect(await desktop('dima.history', { ...remote, ...main })).toEqual(initial)
  expect(calls.mock.lastCall?.[1]).toEqual(main)
  expect(await mobile.history(main, signal)).toEqual(initial)
  expect(mobileCalls.mock.lastCall?.[1]).toEqual(main)
}, 120_000)

it('keeps structured timeline and pending requests scoped across local PC, remote PC and an Android peer', async () => {
  const { host, hostStore, directory, hostOnly, desktop, local, remote, fixture } = await setup()
  const phone = await authenticatedPeer(host, hostStore, new IdentityStore({ directory: join(directory, 'android-timeline') }), 'android')
  const branch = { sessionId: fixture.sessionId, branchId: fixture.branchId }
  for (const call of [
    (method: string, request: object) => hostOnly('dima.' + method, { ...local, request }),
    (method: string, request: object) => desktop('dima.' + method, { ...remote, request }),
    (method: string, request: object) => phone.client.rpc('dima.app.' + method, request),
  ]) {
    let timeline = dimaTimelineSchema.parse(await call('timeline', branch))
    expect(timeline).toMatchObject(branch)
    // A genuine fixture survives the preceding cross-device test. The original reply may now be on an earlier page.
    const hasSeed = () => timeline.turns.some(turn => turn.blocks.some(block => block.kind === 'text' && block.text === 'Echo: branch fixture'))
    for (let i = 0; i < 20 && !hasSeed() && timeline.earlier; i++) {
      const older = dimaTimelineSchema.parse(await call('timeline', { ...branch, cursor: timeline.earlier }))
      expect(older.from).toBeLessThan(timeline.from)
      timeline = mergeDimaTimelinePages(older, timeline)
    }
    expect(hasSeed()).toBe(true)
    const imageBlock = timeline.turns.flatMap(turn => turn.blocks).find(block => block.attachments?.length)
    // The regular transport fixture seeds an image. A genuine mock-model daemon can have text-only history.
    if (!inject('dimaFixture')) expect(imageBlock).toBeDefined()
    if (imageBlock?.attachments?.[0]) {
      const reference = { ...branch, sequence: imageBlock.sequence, ...imageBlock.attachments[0], offset: 0 }
      const chunk = await call('mediaRead', reference)
      expect(chunk).toMatchObject({ ...reference, data: expect.any(String), eof: expect.any(Boolean) })
      if (!inject('dimaFixture')) expect(await call('mediaRead', { ...reference, offset: 8 })).toMatchObject({ ...reference, offset: 8, data: '', eof: true })
      await expect(call('mediaRead', { ...reference, branchId: 'main' })).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
    }
    const inbox = dimaInboxSchema.parse(await call('inbox', branch))
    expect(inbox).toMatchObject({ ...branch, questions: [], queue: [] })
    await expect(call('timeline', { ...branch, branchId: 'missing-branch' })).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  }
  expect(await hostOnly('dima.features', local)).toMatchObject({ read: true, timeline: true, inbox: true })
  expect(await desktop('dima.features', remote)).toMatchObject({ read: true, timeline: true, inbox: true })
}, 30_000)

it('preserves one submission when the encrypted Host acknowledgement is lost', async () => {
  const { host, desktop, peer, hostOnly, local, remote, calls, fixture } = await setup()
  const branch = { sessionId: fixture.sessionId, branchId: fixture.branchId }
  const text = 'disconnected fixture'
  const writes = vi.spyOn(host, 'dimaSubmit')
  calls.mockClear()
  peer.loseNextReply()
  await expect(desktop('dima.submit', { ...remote, ...branch, requestId: randomUUID(), text }))
    .rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
  await vi.waitFor(async () => {
    const history = dimaHistorySchema.parse(await hostOnly('dima.history', { ...local, ...branch, window: 'recent' }))
    expect(history.messages.filter(entry => entry.text === text || entry.text === 'Echo: ' + text)).toEqual([
      { role: 'user', text }, { role: 'assistant', text: 'Echo: ' + text },
    ])
  }, { timeout: 10_000, interval: 100 })
  expect(calls.mock.calls.map(([method]) => method)).toEqual(['dima.app.submit'])
  expect(writes).toHaveBeenCalledTimes(1)
}, 30_000)
