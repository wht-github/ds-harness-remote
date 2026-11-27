/** Pass a dimcode executable to vite-node. The daemon uses a disposable home and a development model configured on loopback. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeRpc, record } from '../../src/dima/native-rpc.js'
import { DimaAppServer } from '../../src/dima/app-server.js'

const binary = process.argv.at(-1)
assert(binary && path.isAbsolute(binary) && !binary.endsWith('.ts'))
const home = await mkdtemp(path.join(tmpdir(), 'dsh-dima-tasks-'))
const cwd = path.join(home, 'workspace')
await mkdir(cwd)
const nativeHome = path.join(home, 'rust')
await mkdir(nativeHome, { mode: 0o700 })
const key = createHash('sha256').update('dimcode:' + path.toNamespacedPath(await realpath(nativeHome))).digest('hex').slice(0, 32)
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\dim-rust-' + key : path.join(nativeHome, 'daemon.sock')
const server = new DimaAppServer({ home, binary })
const owner = 'isolated-owner'
// This loopback model can emit only two fixed tool calls, both confined to the test Session.
const commandMarker = 'fixture command ' + randomUUID(), delegationMarker = 'fixture delegate ' + randomUUID()
const memberMarker = 'fixture member waiting ' + randomUUID()
let commandIssued = false, delegationIssued = false
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const last = body.messages?.at(-1), input = JSON.stringify(last?.content ?? '')
  const memberRequest = JSON.stringify(body.messages?.filter((entry: { role: string }) => entry.role === 'system') ?? []).includes('Wait for the fixture') || input.includes(memberMarker)
  let tool: { name: string; args: object } | undefined
  if (last?.role === 'user' && input.includes(commandMarker) && !commandIssued) {
    commandIssued = true
    tool = { name: 'exec', args: { title: 'Fixture timer', command: process.platform === 'win32' ? 'Write-Output 12345; Start-Sleep -Seconds 40' : 'echo 12345; sleep 40', runInBackground: true, timeoutMs: 45_000 } }
  } else if (last?.role === 'user' && input.includes(delegationMarker) && !delegationIssued) {
    delegationIssued = true
    tool = { name: 'agent', args: { action: 'request', profile: { name: 'fixture-worker', description: 'Fixture worker', systemPrompt: 'Wait for the fixture' }, prompt: memberMarker } }
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  if (memberRequest && !tool && !input.includes(delegationMarker)) {
    response.flushHeaders()
    const timeout = setTimeout(() => response.end('data: [DONE]\n\n'), 40_000)
    response.once('close', () => clearTimeout(timeout))
    return
  }
  const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture-model', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
  const output = tool ? frame({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, null) + frame({}, 'tool_calls') : frame({ content: 'Fixture complete' }, 'stop')
  response.end(output + 'data: [DONE]\n\n')
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const address = model.address()
assert(address && typeof address === 'object')
const modelConfig = path.join(home, 'model.json')
await writeFile(modelConfig, JSON.stringify({ defaultModel: { providerId: 'fixture', modelId: 'fixture-model' }, providers: [
  { id: 'fixture', kind: 'openai-compatible', apiKeyEnv: 'FIXTURE_MODEL_KEY', baseUrl: 'http://127.0.0.1:' + address.port + '/v1', models: [{ id: 'fixture-model', contextWindow: 128000, maxOutputTokens: 4096, config: { maxTokens: 128 } }] },
] }))
const daemon = spawn(binary, ['app-server', '--model-config', modelConfig, '--no-ws', '--home', nativeHome, process.platform === 'win32' ? '--pipe' : '--unix', endpoint], {
  cwd, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TMP: home, TEMP: home, TMPDIR: home, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: home, APPDATA: home, DIMCODE_HOME: home, FIXTURE_MODEL_KEY: 'fixture' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})
const exited = once(daemon, 'close'), deadline = setTimeout(() => daemon.kill(), 45_000)
const ready = createInterface({ input: daemon.stdout })
try {
  await Promise.race([once(ready, 'line', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw Error('Daemon exited before ready') })])
  const socket = connect(endpoint)
  try {
    const rpc = new NativeRpc(socket, socket)
    await rpc.call('hello', { protocolVersion: 4, clientKind: 'other' })
    const features = await server.features()
    assert(features.goal && features.goalUpdate && features.tasks && features.conversationExport)
    const created = record(await rpc.call('session.create', { cwd, permissionPolicy: { preset: 'workspace-write', allowedTools: ['exec', 'agent'] } }))
    assert.equal(typeof created.sessionId, 'string')
    const p = { sessionId: created.sessionId as string, branchId: 'main' as const }
    await rpc.call('session.attach', { sessionId: p.sessionId, expectedCwd: cwd })
    const table = record(await rpc.call('session.methods', { sessionId: p.sessionId })).methods as Array<{name:string}>
    const names = table.map(m => m.name)
    assert(names.includes('session.goal.get'))
    assert.equal((await server.goal(p, owner)).goal, null)
    const update = (action: 'set' | 'edit', objective: string) => server.goalUpdate({ ...p, action, objective, operationId: randomUUID() }, owner)
    const control = (action: 'pause' | 'resume' | 'clear') => server.goalUpdate({ ...p, action, operationId: randomUUID() }, owner)
    const setGoal = { ...p, action: 'set' as const, objective: 'isolated goal', operationId: randomUUID() }
    const receipt = await server.goalUpdate(setGoal, owner)
    assert.equal(receipt.goal?.objective, 'isolated goal')
    assert.equal((await update('edit', 'revised isolated goal')).goal?.objective, 'revised isolated goal')
    assert.equal((await control('pause')).goal?.status, 'paused')
    assert.equal((await control('resume')).goal?.status, 'active')
    assert.equal((await control('clear')).goal, null)
    assert.equal((await server.goal(p, owner)).goal, null)
    assert.deepEqual(await server.goalUpdate(setGoal, owner), receipt)
    assert.equal((await server.goal(p, owner)).goal, null)
    console.log('native goal lifecycle and owner-scoped replay passed')
    const inventory = await server.tasks(p, owner)
    assert.equal(inventory.sources.commands, names.includes('session.exec.pending')); assert(inventory.sources.members); assert.deepEqual(inventory.items, [])
    console.log('native task inventory and source availability passed')
    const waitForTask = async (kind: 'command' | 'member', state?: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = (await server.tasks(p, owner)).items.find(row => row.target.kind === kind && (state ? row.state === state : row.canStop))
        if (found) return found
        await delay(100)
      }
      throw Error('Fixture task did not reach ' + (state ?? 'stoppable') + ' for ' + kind + ', issued=' + [commandIssued, delegationIssued].join('/'))
    }
    for (const [kind, text] of [['command', commandMarker], ['member', delegationMarker]] as const) {
      await server.submit({ ...p, requestId: randomUUID(), text }, owner)
      const row = await waitForTask(kind)
      let detail = await server.taskDetail({ ...p, target: row.target }, owner)
      assert.equal(detail.target.id, row.target.id)
      if (kind === 'command') {
        for (let attempt = 0; !detail.text.includes('12345'); attempt++) {
          if (attempt === 50) {
            const latest = (await server.tasks(p, owner)).items.find(item => item.target.id === row.target.id)
            throw Error('Missing fixture timer output, task state=' + latest?.state + ', detail length=' + detail.text.length + ', output methods=' + names.filter(name => name.startsWith('session.exec.output')).join(','))
          }
          await delay(100)
          detail = await server.taskDetail({ ...p, target: row.target }, owner)
        }
      } else {
        assert(detail.text.includes(memberMarker))
      }
      const stop = { ...p, target: row.target, operationId: randomUUID() }
      const receipt = await server.taskStop(stop, owner)
      assert.equal(receipt.target.id, row.target.id)
      assert.deepEqual(await server.taskStop(stop, owner), receipt)
      assert.equal((await waitForTask(kind, 'cancelled')).target.id, row.target.id)
      console.log('native ' + kind + ' detail, exact stop and cancelled terminal state passed')
    }
    const id = randomUUID(), message = 'export fixture ' + randomUUID()
    await rpc.call('session.submit', { ...p, text: message, submissionId: id })
    for (let attempt = 0; ; attempt++) {
      const result = await server.conversationExport({ ...p, format: 'markdown' }, owner)
      if (result.text.includes(message)) break
      assert(attempt < 50); await delay(100)
    }
    for (let attempt = 0; (await server.status(p, owner)).running; attempt++) {
      assert(attempt < 100, 'fixture branch must finish before forking')
      await delay(100)
    }
    const directory = record(await rpc.call('session.branches', { sessionId: p.sessionId })).branches as Array<{ branchId: string; head: number }>
    const at = directory.find(row => row.branchId === 'main')?.head
    assert(typeof at === 'number' && at > 0)
    const fork = record(await rpc.call('session.branch_create', { sessionId: p.sessionId, parentBranchId: 'main', at, prompt: 'fixture child' }))
    const branchId = record(fork.branch).branchId
    assert(typeof branchId === 'string' && branchId !== 'main')
    const privateGoal = 'child-only goal ' + randomUUID()
    const child = { sessionId: p.sessionId, branchId }
    assert.equal((await server.goalUpdate({ ...child, action: 'set', objective: privateGoal, operationId: randomUUID() }, owner)).goal?.objective, privateGoal)
    assert.equal((await server.goal(p, owner)).goal, null)
    await server.tasks(child, owner)
    const exported = await server.conversationExport({ ...p, format: 'json' }, owner)
    const document = JSON.parse(exported.text)
    assert.equal(document.sessionId, p.sessionId)
    assert.equal(document.branchId, 'main')
    assert(document.events.length)
    assert(!exported.text.includes(privateGoal))
    const markdown = await server.conversationExport({ ...p, format: 'markdown' }, owner)
    assert(markdown.text.includes('Child branch ' + branchId + ' (contents not exported).'))
    assert(!markdown.text.includes(privateGoal))
    console.log('native branch-specific goals, cross-branch inventory and main-only exports passed')
  } finally { socket.destroy() }
} finally { server.dispose(); clearTimeout(deadline); ready.close(); daemon.kill(); await exited; model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(home, { recursive: true, force: true }) }
