/** pnpm --dir packages/plugin exec vite-node tests/fixtures/dima-native-daemon.ts <absolute dimcode executable> */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { DimaAppServer } from '../../src/dima/app-server.js'

const binary = process.argv.at(-1)
assert(binary && path.isAbsolute(binary) && !binary.endsWith('.ts'), 'Pass the absolute native dimcode executable as the final argument.')
const home = await mkdtemp(path.join(tmpdir(), 'dima-native-'))
const nativeHome = path.join(home, 'rust')
const cwd = path.join(home, 'workspace')
await mkdir(nativeHome, { mode: 0o700 })
await mkdir(cwd)
const key = createHash('sha256').update('dimcode:' + path.toNamespacedPath(await realpath(nativeHome))).digest('hex').slice(0, 32)
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\dim-rust-' + key : path.join(nativeHome, 'daemon.sock')
const daemon = spawn(binary, ['app-server', '--mock-model', '--no-ws', '--home', nativeHome,
  process.platform === 'win32' ? '--pipe' : '--unix', endpoint],
{ cwd, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TMP: home, TEMP: home, TMPDIR: home,
  USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, DIMCODE_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const exited = new Promise<void>(resolve => daemon.once('close', () => resolve()))
// A broken fixture protocol or an uninterruptible turn must still release this test daemon.
const deadline = setTimeout(() => daemon.kill(), 45_000)
const server = new DimaAppServer({ home, binary }, () => [])
const owner = 'fixture-device'
const readline = createInterface({ input: daemon.stdout })
let startupError = ''
daemon.on('error', error => { startupError = error.message })
const onStartupError = (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2048) }
daemon.stderr.on('data', onStartupError)
try {
  const [ready] = await Promise.race([once(readline, 'line', { signal: AbortSignal.timeout(15_000) }),
    exited.then((): never => { throw new Error('The isolated daemon exited at startup: ' + startupError) })])
  daemon.stderr.off('data', onStartupError)
  const info = JSON.parse(ready)
  assert.equal(process.platform === 'win32' ? info.pipeName : info.unixPath, endpoint)
  assert.equal(info.websocketAddress, null)
  assert(await server.interactionAvailable())
  const features = await server.features()
  assert(features.timeline && features.act && features.inbox && features.options)
  const seed = connect(endpoint)
  const responses = createInterface({ input: seed })[Symbol.asyncIterator]()
  let nextId = 0
  async function fixtureCall(method: string, params: unknown) {
    const id = ++nextId
    seed.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (;;) {
      const frame = await responses.next()
      assert(!frame.done)
      const reply = JSON.parse(frame.value)
      if (!('id' in reply)) continue
      assert.equal(reply.id, id)
      assert(!reply.error, method + ' fixture setup failed: ' + JSON.stringify(reply.error))
      return reply.result
    }
  }
  try {
    await fixtureCall('hello', { protocolVersion: 4, clientKind: 'other' })
    const created = await fixtureCall('session.create', { cwd, permissionPolicy: { preset: 'workspace-write' } })
    const known = (await server.catalog()).workspaces.find(w => w.sessions.some(s => s.sessionId === created.sessionId))
    assert(known)
    const create = { cwd: known.cwd, requestId: randomUUID() }
    const newSession = await server.create(create, owner)
    assert.deepEqual(await server.create(create, owner), newSession)
    assert.notEqual(newSession.sessionId, created.sessionId)
    const sessionId = created.sessionId
    const root = { sessionId, branchId: 'main' }
    await server.submit({ ...root, requestId: randomUUID(), text: 'seed main' }, owner)
    const idle = (target: typeof root) => fixtureCall('session.idle', target)
    await idle(root)
    const head = (await fixtureCall('session.branches', { sessionId })).branches.find((b: typeof root) => b.branchId === 'main').head
    const fork = await fixtureCall('session.branch_create', { sessionId, parentBranchId: 'main', at: head, prompt: 'seed child' })
    const child = { sessionId, branchId: fork.branch.branchId }
    await idle(child)
    const text = 'native child only'
    const submit = { ...child, requestId: randomUUID(), text }
    assert.deepEqual(await server.submit(submit, owner), await server.submit(submit, owner))
    await idle(child)
    const reopened = new DimaAppServer({ home, binary })
    try { await reopened.submit(submit, owner) } finally { reopened.dispose() }
    const history = await server.history(child)
    assert.equal(history.messages.filter(m => m.role === 'user' && m.text === text).length, 1)
    assert(history.messages.some(m => m.role === 'assistant' && m.text.includes(text)))
    assert(!(await server.history(root)).messages.some(m => m.text.includes(text)))
    const timeline = await server.timeline(child, owner)
    assert.deepEqual([timeline.sessionId, timeline.branchId], [child.sessionId, child.branchId])
    assert(timeline.turns.some(turn => turn.blocks.some(block => block.kind === 'text' && block.text.includes(text))))
    const earlier = timeline.earlier
    if (earlier) {
      const previous = await server.timeline({ ...child, cursor: earlier }, owner)
      assert.equal(previous.instanceId, timeline.instanceId)
      assert.equal(previous.through, timeline.through)
      assert(previous.to < earlier.before)
    }
    const branchOptions = await server.options(child, owner)
    assert.deepEqual([branchOptions.sessionId, branchOptions.branchId], [child.sessionId, child.branchId])
    if (features.extensions) {
      const extensions = await server.extensions({ cwd: known.cwd }, owner)
      assert(extensions.items.every(item => !item.canToggle))
    }
    if (features.conversationExport) {
      const exported = await server.conversationExport({ sessionId, branchId: 'main', format: 'markdown' }, owner)
      assert(exported.text.includes('seed main'))
    }
    const wait = 'tool:wait {"millis":60000}'
    await server.submit({ ...root, requestId: randomUUID(), text: wait }, owner)
    await server.submit({ ...child, requestId: randomUUID(), text: wait }, owner)
    for (const target of [root, child]) {
      let state = await server.status(target, owner)
      for (let attempt = 0; attempt < 40 && !state.running; attempt++) {
        await delay(25)
        state = await server.status(target, owner)
      }
      assert(state.running)
    }
    const activeInbox = await server.inbox(child, owner)
    assert(activeInbox.actions.includes('withdraw'))
    const pendingText = 'queued instruction only on the child'
    await server.submit({ ...child, requestId: randomUUID(), text: pendingText }, owner)
    const queued = (await server.inbox(child, owner)).queue.find(item => item.text === pendingText)
    assert(queued?.editable)
    assert(!(await server.inbox(root, owner)).queue.some(item => item.inputId === queued.inputId))
    const retrieve = { ...child, kind: 'retrieve' as const, operationId: randomUUID(), inputId: queued.inputId }
    assert.equal((await server.act(retrieve, owner)).restoredText, pendingText)
    assert.equal((await server.act(retrieve, owner)).restoredText, pendingText)
    assert(!(await server.inbox(child, owner)).queue.some(item => item.inputId === queued.inputId))
    assert.deepEqual(await server.interrupt(child, owner), child)
    await idle(child)
    assert(!(await server.status(child, owner)).running)
    const latest = (target: typeof root) => fixtureCall('session.history', { ...target, latestTurn: true, limit: 128 })
    const end = (page: { events: Array<{ type: string; name: string; data: Record<string, unknown> }> }) =>
      page.events.slice().reverse().find(e => e.type === 'turn' && e.name === 'end')?.data
    const cancelled = end(await latest(child))
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(typeof cancelled?.turn_id, 'string')
    assert.equal(typeof cancelled?.reason, 'string')
    assert.equal((await server.history({ ...child, window: 'recent' })).lastTurnIssue?.status, 'cancelled')
    assert((await server.status(root, owner)).running)
    await server.interrupt(root, owner)
    await idle(root)
    // Malformed mock-tool input makes the mock model's generate() fail offline.
    await server.submit({ ...child, requestId: randomUUID(), text: 'tool:echo invalid-json' }, owner)
    await idle(child)
    const failed = end(await latest(child))
    assert.equal(failed?.status, 'failed')
    assert.equal(typeof failed?.turn_id, 'string')
    assert.equal(typeof failed?.error, 'string')
    assert.equal((await server.history({ ...child, window: 'recent' })).lastTurnIssue?.status, 'failed')
    const endChild = { ...child, kind: 'endBranch' as const, operationId: randomUUID() }
    const ended = await server.act(endChild, owner)
    assert.deepEqual(await server.act(endChild, owner), ended)
    console.log('Isolated DimAgent v4 daemon passed create, child submit, structured timeline, options, pending input recovery, deduplication and targeted interrupt.')
  } finally { seed.destroy() }
} finally {
  clearTimeout(deadline)
  server.dispose()
  readline.close()
  daemon.kill()
  await exited
  await rm(home, { recursive: true, force: true })
}
