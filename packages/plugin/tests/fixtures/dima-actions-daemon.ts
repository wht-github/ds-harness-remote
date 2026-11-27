/** Run via vite-node tests/fixtures/dima-actions-daemon.ts [--product | --configured] <absolute dimcode executable>.
 * Default mock tests durable queue and branch operations. Product enables the local synthetic model catalog,
 * effort, interactive questions, Agent, rename and compact. --configured exercises execution with no product catalog.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { DimaActions, type DimaActionContext } from '../../src/dima/actions.js'
import { NativeRpc } from '../../src/dima/native-rpc.js'
import type { DimaActionRequest } from '@dsh-remote/protocol'

const executable = process.argv.at(-1)
assert(executable && path.isAbsolute(executable) && !executable.endsWith('.ts'))
const home = await mkdtemp(path.join(tmpdir(), 'dim-action-test-'))
const cwd = path.join(home, 'workspace')
await mkdir(cwd)
const windows = process.platform === 'win32'
const endpoint = windows ? '\\\\.\\pipe\\dim-actions-' + randomUUID() : path.join(home, 'actions.sock')
const product = process.argv.includes('--product')
const configured = product || process.argv.includes('--configured')
const productProviderId = '018ec73f-0000-7000-8000-0000000000aa'
const question = { questions: [
  { question: 'Pick one', options: [{ label: 'one' }, { label: 'two' }] },
  { id: 'extra', question: 'Pick more', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
] }
let pendingQuestion = false
const provider = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const ask = pendingQuestion && body.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'ask_user')
  if (ask) pendingQuestion = false
  const delta = ask ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
    function: { name: 'ask_user', arguments: JSON.stringify(question) } }] } : { role: 'assistant', content: 'fixture completed' }
  const frame = (delta: unknown, finish_reason: unknown) => 'data: ' + JSON.stringify({ id: 'fixture-output', object: 'chat.completion.chunk',
    created: 1, model: 'fixture-a', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(frame(delta, null) + frame({}, ask ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
})
const configPath = path.join(home, 'model.json')
if (configured) {
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const address = provider.address()
  assert(address && typeof address === 'object')
  await writeFile(configPath, JSON.stringify({ defaultModel: { providerId: 'fixture', modelId: 'fixture-a' }, providers: [{
    id: 'fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    models: ['fixture-a','fixture-b'].map(id => ({ id, contextWindow: 32_000, maxOutputTokens: 2048, config: { maxTokens: 2048 } })),
  }] }))
}
const profile = product ? ['--product-home', home] : configured ? ['--model-config', configPath] : ['--mock-model']
const daemon = spawn(executable, ['app-server', ...profile, '--no-ws', '--home', home, windows ? '--pipe' : '--unix', endpoint], {
  cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMP: home, TEMP: home, TMPDIR: home,
    USERPROFILE: home, HOME: home, LOCALAPPDATA: home, APPDATA: home, DIMCODE_HOME: home }, stdio: ['ignore','pipe','pipe'], windowsHide: true,
})
const deadline = setTimeout(() => daemon.kill(), 70_000)
const done = once(daemon, 'close')
let cleanup = () => {}
try {
  const start = createInterface({ input: daemon.stdout })
  const [ready] = await Promise.race([once(start, 'line', { signal: AbortSignal.timeout(10_000) }), done.then((): never => { throw Error('daemon exited') })])
  assert.equal(JSON.parse(ready).websocketAddress, null)
  const socket = connect(endpoint)
  cleanup = () => { socket.destroy(); start.close() }
  const rpc = new NativeRpc(socket, socket)
  const call = async (method: string, params: Record<string, unknown>) => await rpc.call(method as Parameters<NativeRpc['call']>[0], params) as Record<string, any>
  const hello = await call('hello', { protocolVersion: 4, clientKind: 'other' })
  if (product) {
    const address = provider.address()
    assert(address && typeof address === 'object')
    const models = ['fixture-a','fixture-b'].map(modelId => ({ modelId, displayName: modelId, status: 'active', capabilities: {
      modalities: ['text'], toolCalling: true, streaming: true, structuredOutput: true, vision: false, audio: false,
      reasoning: true, contextWindow: 32000, maxOutputTokens: 2048 }, metadata: { reasoning: { supported: true, effortOptions: ['low','high'] } } }))
    await call('provider.create', { providerId: productProviderId, displayName: 'Fixture', enabled: true, models,
      connection: { driverKind: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + address.port + '/v1', auth: { type: 'anonymous' } } })
    await call('provider.select', { cwd, providerId: productProviderId, modelId: 'fixture-a' })
  }
  const opened = await call('session.create', { cwd, permissionPolicy: { preset: 'workspace-write' } })
  const target = { sessionId: opened.sessionId as string, branchId: 'main' }
  const ctx: DimaActionContext = { owner: 'device:a', state: 'open', instanceId: hello.instanceId, features: hello.features }
  await call('session.attach', { sessionId: target.sessionId, expectedCwd: opened.cwd ?? cwd })
  const ops = new DimaActions()
  const opts = await ops.options(rpc, target, ctx)
  assert.equal(opts.branchId, target.branchId)
  const inventory = () => ops.inbox(rpc, target, ctx)
  const act = (fields: Record<string, unknown>, branch = target, who = ctx) => ops.act(rpc, { ...branch, ...fields, operationId: randomUUID() } as DimaActionRequest, who)
  console.log('native actions', (await inventory()).actions, '; model options', opts.models?.length)
  if (configured) {
    const initial = await inventory()
    assert(initial.actions.includes('answer'))
    pendingQuestion = true
    await call('session.submit', { ...target, text: 'Please ask and wait.' })
    let inbox = await inventory()
    for (let i = 0; !inbox.questions.length && i < 80; i++) { await delay(40); inbox = await inventory() }
    const asked = inbox.questions[0]
    assert.equal(asked?.questions.length, 2)
    const identity = { eventId: asked.eventId, requestId: asked.requestId, callId: asked.callId }
    const other = { ...ctx, owner: 'device:configured-other' }
    const reply = { ...target, ...identity, kind: 'answer' as const, operationId: randomUUID(), answers: [
      { questionId: '1', selected: ['two'] }, { questionId: 'extra', selected: ['x', 'y'], custom: 'also custom' },
    ] }
    const socketB = connect(endpoint)
    try {
      const rpcB = new NativeRpc(socketB, socketB)
      await rpcB.call('hello', { protocolVersion: 4, clientKind: 'other' })
      await rpcB.call('session.attach', { sessionId: target.sessionId, expectedCwd: opened.cwd ?? cwd })
      assert.deepEqual((await ops.inbox(rpcB, target, other)).questions, inbox.questions)
      assert.equal((await ops.act(rpcB, reply, other)).kind, 'answer')
    } finally { socketB.destroy() }
    await call('session.idle', target)
    assert.equal((await inventory()).questions.length, 0)
    const options = await ops.options(rpc, target, ctx)
    assert(options.usage && options.usage.contextWindow > 0)
    assert.equal(options.model?.modelId, 'fixture-a')
    if (product) {
      assert(initial.actions.includes('setEffort') && initial.actions.includes('setModel'))
      assert(options.models?.find(m => m.modelId === 'fixture-a')?.efforts.includes('high'))
      await act({ kind: 'setEffort', effort: 'high' })
      assert.equal((await ops.options(rpc, target, ctx)).effort, 'high')
      assert(options.models?.some(m => m.modelId === 'fixture-b'))
      await act({ kind: 'setModel', provider: productProviderId, modelId: 'fixture-b' })
      assert.equal((await ops.options(rpc, target, ctx)).model?.modelId, 'fixture-b')
    }
    assert(options.agents?.length)
    await act({ kind: 'setAgent', agentId: options.agents[0].agentId })
    for (let i = 0; i < 4; i++) {
      await call('session.submit', { ...target, text: 'fixture prior context '.repeat(240) })
      await call('session.idle', target)
    }
    assert.equal((await act({ kind: 'compact' })).detail, 'completed')
    assert(initial.actions.includes('rename'))
    await act({ kind: 'rename', title: 'renamed by fixture' })
    await act({ kind: 'rename', title: null })
    console.log('Verified native questions, context, Agent configuration and session title' + (product ? ', model and reasoning effort.' : '.'))
  } else {
    await call('session.submit', { ...target, text: 'tool:wait {"millis":25000}' })
    await delay(170)
    for (const text of ['restore one', 'withdraw two', 'atomically steer three']) await call('session.submit', { ...target, mode: 'queue', text })
    const snap = await inventory()
    assert.deepEqual(snap.queue.map(r => r.text), ['restore one', 'withdraw two', 'atomically steer three'])
    const second = { ...ctx, owner: 'device:b' }
    await assert.rejects(act({ kind: 'retrieve', inputId: snap.queue[0].inputId }, target, second), { code: 'DIMA_ACTION_STALE' })
    const freshSocket = connect(endpoint)
    try {
      const renewed = new NativeRpc(freshSocket, freshSocket)
      await renewed.call('hello', { protocolVersion: 4, clientKind: 'other' })
      await renewed.call('session.attach', { sessionId: target.sessionId, expectedCwd: opened.cwd ?? cwd })
      const recovered = await ops.inbox(renewed, target, second)
      assert.deepEqual(recovered.queue, snap.queue)
      const withdrawn = await ops.act(renewed, { ...target, kind: 'retrieve', operationId: randomUUID(), inputId: snap.queue[0].inputId }, second)
      assert.equal(withdrawn.restoredText, 'restore one')
    } finally { freshSocket.destroy() }
    await assert.rejects(act({ kind: 'retrieve', inputId: snap.queue[0].inputId }), { code: 'DIMA_INPUT_NOT_HELD' })
    await act({ kind: 'withdraw', inputId: snap.queue[1].inputId })
    await act({ kind: 'steerQueued', inputId: snap.queue[2].inputId })
    await act({ kind: 'steer', text: 'live guidance' })
    await call('session.stop', target)
    await call('session.idle', target)
    await call('session.submit', { ...target, text: 'finished turn' })
    await call('session.idle', target)
    const forked = await act({ kind: 'fork' })
    assert(forked.newSessionId && forked.newSessionId !== target.sessionId)
    assert.equal(forked.newBranchId, 'main')
    const branch = await act({ kind: 'branchCreate', text: 'create child' })
    assert(branch.newBranchId)
    const child = { ...target, branchId: branch.newBranchId }
    await call('session.idle', child)
    await act({ kind: 'setDefault' }, child)
    await act({ kind: 'setDefault' })
    await act({ kind: 'endBranch' }, child)
    assert.equal((await call('session.branches', { sessionId: target.sessionId })).branches.find((r: typeof child) => r.branchId === child.branchId).state, 'ended')
    await assert.rejects(act({ kind: 'compact' }), { code: 'DIMA_INCOMPATIBLE' })

    console.log('verified native action fixture')
  }
} finally {
  cleanup(); daemon.kill(); clearTimeout(deadline); await done; provider.close(); provider.closeAllConnections(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
