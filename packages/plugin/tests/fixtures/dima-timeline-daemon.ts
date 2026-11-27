/** pnpm --dir packages/plugin exec vite-node tests/fixtures/dima-timeline-daemon.ts <native dimcode executable> */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { dimaTimelineSchema, mergeDimaTimelinePages, type DimaTimelineCursor } from '@dsh-remote/protocol'
import { DimaAppServer } from '../../src/dima/app-server.js'

const binary = process.argv.at(-1)
assert(binary && path.isAbsolute(binary), 'Pass the absolute dimcode executable.')
const home = await mkdtemp(path.join(tmpdir(), 'dim-timeline-')), nativeHome = path.join(home, 'rust')
await mkdir(nativeHome, { mode: 0o700 })
const cwd = path.join(home, 'project')
await mkdir(cwd)
let hold: ServerResponse | undefined
let release = false
let nextTool: { name: string; arguments: string } | undefined
const chunk = (delta: object, end: string | null = null) => 'data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1,
  model: 'timeline', choices: [{ index: 0, delta, finish_reason: end }],
  ...(end && { usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } }) }) + '\n\n'
const finish = (res: ServerResponse) => res.end(chunk({ content: ' end' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')
const provider = createServer(async (req, res) => {
  for await (const _ of req) { /* consume local fixture request */ }
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  if (nextTool) {
    const tool = nextTool
    nextTool = undefined
    res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool-call', type: 'function', function: tool }] }))
    res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
    return
  }
  res.write(chunk({ role: 'assistant', content: 'Live 🌱' }))
  if (release) finish(res)
  else hold = res
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
const address = provider.address(); assert(address && typeof address === 'object')
const config = path.join(home, 'models.json')
await writeFile(config, JSON.stringify({ defaultModel: { providerId: 'local', modelId: 'timeline' }, providers: [{ id: 'local',
  kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + address.port + '/v1', models: [{ id: 'timeline', contextWindow: 128000,
    maxOutputTokens: 4096, config: { maxTokens: 128 } }] }] }))
const key = createHash('sha256').update('dimcode:' + path.toNamespacedPath(await realpath(nativeHome))).digest('hex').slice(0, 32)
const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\dim-rust-` + key : path.join(nativeHome, 'daemon.sock')
const daemon = spawn(binary, ['app-server', '--model-config', config, '--no-ws', '--home', nativeHome,
  process.platform === 'win32' ? '--pipe' : '--unix', endpoint], { cwd,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
    APPDATA: home, LOCALAPPDATA: home, DIMCODE_HOME: home, OPENAI_API_KEY: 'offline-fixture' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const exited = new Promise(resolve => daemon.once('close', resolve))
const lines = createInterface({ input: daemon.stdout })
const timer = setTimeout(() => daemon.kill(), 45_000)
let stderr = ''; daemon.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4096) })
try {
  const [line] = await Promise.race([once(lines, 'line', { signal: AbortSignal.timeout(12_000) }),
    exited.then((): never => { throw Error('Fixture startup: ' + stderr) })])
  assert.equal(JSON.parse(line).websocketAddress, null)
  const socket = connect(endpoint)
  const replies = createInterface({ input: socket })[Symbol.asyncIterator]()
  let next = 0
  async function call(method: string, params: object) {
    const id = ++next
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (;;) {
      const data = await replies.next(); assert(!data.done)
      const reply = JSON.parse(data.value)
      if (reply.id !== id) continue
      assert(!reply.error, method + ': ' + JSON.stringify(reply.error)); return reply.result
    }
  }
  try {
    const hello = await call('hello', { protocolVersion: 4, clientKind: 'other', clientName: 'timeline-fixture' })
    assert(hello.features.includes('session.history.display.transcript'))
    const created = await call('session.create', { cwd, interactive: true })
    const sessionId = created.sessionId, target = { sessionId, branchId: 'main' }
    const read = async (cursor?: DimaTimelineCursor, branch = 'main') => {
      const host = new DimaAppServer({ home, binary })
      try { return dimaTimelineSchema.parse(await host.timeline({ sessionId, branchId: branch, cursor }, 'loopback')) }
      finally { host.dispose() }
    }
    const submit = (text: string) => call('session.submit', { ...target, text, mode: 'queue', submissionId: randomUUID() })
    await submit('first')
    for (let i = 0; i < 75 && !hold; i++) await delay(40)
    assert(hold, 'Local provider did not receive the turn')
    let live = await read()
    for (let i = 0; i < 25 && !live.turns.flatMap(t => t.blocks).some(b => b.text === 'Live 🌱'); i++) { await delay(40); live = await read() }
    assert(live.activity?.running)
    const block = live.turns.flatMap(t => t.blocks).find(b => b.kind === 'text' && b.text === 'Live 🌱')
    assert(block?.live, 'Must show the native uncommitted progress cell')
    const fixed = await call('session.history.display', { ...target, tail: true, transcript: true, limit: 32 })
    assert(!fixed.items.some((e: { type: string; name: string }) => e.type === 'step' && e.name === 'text'))
    release = true; finish(hold)
    await call('session.idle', target)
    const settled = await read(), combined = mergeDimaTimelinePages(live, settled)
    const final = combined.turns.flatMap(t => t.blocks).filter(b => b.kind === 'text')
    assert.equal(final.length, 1); assert.equal(final[0].id, block.id); assert.equal(final[0].text, 'Live 🌱 end')
    for (let i = 0; i < 12; i++) { await submit('more ' + i); await call('session.idle', target) }
    let window = await read(), pages = 1
    assert(window.earlier)
    const original = window.through
    while (window.earlier) {
      const older = await read(window.earlier); assert.equal(older.through, original)
      window = mergeDimaTimelinePages(older, window)
      assert(++pages < 20)
    }
    assert.equal(window.turns.length, 13)
    assert(window.turns.every(t => t.status === 'completed' && t.blocks[0]?.kind === 'user' && t.blocks[1]?.kind === 'text'))
    const all = window.turns.flatMap(t => t.blocks)
    assert.equal(all.filter(b => b.kind === 'text').length, 13)
    assert.equal(all.filter(b => b.kind === 'user').length, 13)
    assert.equal(all.filter(b => b.kind === 'user' && b.text === 'first').length, 1)
    assert(window.turns.every(t => t.startedAt !== undefined && t.endedAt! >= t.startedAt))
    assert(window.turns.every(t => t.usage?.[0]?.totalTokens === 20 && t.usage[0].promptTokens === 17))
    nextTool = { name: 'read', arguments: '{"path":"absent-fixture-file"}' }
    await submit('call the fixture tool'); await call('session.idle', target)
    const failedTool = (await read()).turns.flatMap(t => t.blocks).find(b => b.kind === 'tool' && b.tool === 'read')
    assert(failedTool, 'Expected the native read call in history')
    assert.equal(failedTool.input, '{"path":"absent-fixture-file"}')
    assert(failedTool.output && failedTool.state === 'failed')
    nextTool = { name: 'ask_user', arguments: JSON.stringify({ questions: [{ header: 'Fixture', question: 'Which fixture?',
      options: [{ label: 'One' }, { label: 'Two' }] }] }) }
    await submit('ask a fixture question')
    let pending = await call('session.question.pending', target)
    for (let i = 0; i < 50 && !pending.batches.length; i++) { await delay(50); pending = await call('session.question.pending', target) }
    assert(pending.batches.length, 'Expected a waiting ask_user')
    const ask = pending.batches[0]
    await call('session.question.respond', { ...target, requestId: ask.requestId, callId: ask.calls[0].id, answers: [{ questionId: '1', selected: ['Two'] }] })
    await call('session.idle', target)
    const answered = (await read()).turns.flatMap(t => t.blocks).find(b => b.tool === 'ask_user' && b.requestId === ask.requestId)
    assert(answered?.input?.includes('Which fixture?') && answered.output?.includes('Two') && answered.state === 'completed')
    release = false; hold = undefined
    await submit('hold this turn')
    for (let i = 0; i < 75 && !hold; i++) await delay(40)
    assert(hold, 'Expected a held provider request')
    const imagePath = path.join(home, 'fixture.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAo0AAAAASUVORK5CYII=', 'base64'))
    const stored = await call('attachment.import', { sessionId, path: imagePath, image: true })
    await call('session.submit', { ...target, submissionId: randomUUID(), mode: 'queue', user: { content: [
      { type: 'text', text: 'queued while running' }, { type: 'image', source: stored.image }] } })
    const queued = await read()
    assert(queued.activity?.running)
    const fileBlock = queued.turns.flatMap(t => t.blocks).find(b => b.kind === 'user' && b.text.includes('queued while running'))
    assert.deepEqual(fileBlock?.attachments, [{ fileId: stored.attachmentId, mediaType: stored.image.mediaType }])
    release = true; finish(hold); await call('session.idle', target)
    const fork = await call('session.branch_create', { sessionId, parentBranchId: 'main', at: original, prompt: 'only on child' })
    await call('session.idle', { sessionId, branchId: fork.branch.branchId })
    const child = await read(undefined, fork.branch.branchId)
    assert(child.turns.flatMap(t => t.blocks).some(b => b.text === 'only on child'))
    assert(!(await read()).turns.flatMap(t => t.blocks).some(b => b.text === 'only on child'))
    console.log('Verified native model progress, ' + pages + ' history pages, 13 turn timings and token counts, tool results, answered questions, queued image identity and branch isolation.')
  } finally { socket.destroy() }
} finally {
  clearTimeout(timer); lines.close(); daemon.kill(); await exited
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
}
