/** pnpm --dir packages/plugin exec vite-node tests/fixtures/dima-extensions-daemon.ts <absolute dimcode executable> */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { DimaExtension } from '@dsh-remote/protocol'
import { DimaAppServer } from '../../src/dima/app-server.js'
import { withNativeRpc, record } from '../../src/dima/native-rpc.js'

const binary = process.argv.at(-1)
assert(binary && path.isAbsolute(binary) && !binary.endsWith('.ts'), 'Supply the native dimcode executable.')
const home = await mkdtemp(path.join(tmpdir(), 'dim-ext-'))
const native = path.join(home, 'rust')
const workspace = path.join(home, 'repo')
const secondWorkspace = path.join(home, 'other')
const host = path.join(home, 'host')
const policy = path.join(host, 'ds-harness-remote', 'dima-extension-grants.json')
const skillText = (name: string) => ['---', 'name: ' + name, 'description: Review changes', '---', 'Review the change.', ''].join('\n')
const sentinel = 'unpublished-fixture-config'
const mcpDocument = JSON.stringify({ mcpServers: { 'local-review': { type: 'http', url: 'http://127.0.0.1:1/' + sentinel } } })
await mkdir(native, { mode: 0o700 })
await mkdir(path.dirname(policy), { recursive: true, mode: 0o700 })
for (const repo of [workspace, secondWorkspace]) {
  const projectSkill = path.join(repo, '.agents', 'skills', 'review')
  await mkdir(projectSkill, { recursive: true })
  await writeFile(path.join(projectSkill, 'SKILL.md'), skillText('review'))
  await writeFile(path.join(repo, '.mcp.json'), mcpDocument)
}
const userSkill = path.join(home, '.agents', 'skills', 'common')
await mkdir(userSkill, { recursive: true })
await writeFile(path.join(userSkill, 'SKILL.md'), skillText('common'))
await writeFile(path.join(native, 'mcp.json'), JSON.stringify({ mcpServers: {
  'user-review': { type: 'http', url: 'http://127.0.0.1:1', enabled: false },
} }))
// The upstream mock-model composition omits Skill and MCP management. The normal model-config
// composition can enumerate and toggle them without making any generation request.
const defaults = path.join(home, 'defaults.json')
const dataPlugin = path.join(home, 'notes')
await mkdir(path.join(dataPlugin, 'skills'), { recursive: true })
await writeFile(path.join(dataPlugin, 'dim-plugin.json'), JSON.stringify({ name: 'notes', skills: 'skills' }))
await writeFile(defaults, JSON.stringify({ plugins: { notes: 'notes' }, locked: ['PluginManager', 'Rpc', 'Transport'] }))
const models = path.join(home, 'models.json')
await writeFile(models, JSON.stringify({
  defaultModel: { providerId: 'fixture', modelId: 'offline' },
  providers: [{ id: 'fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'offline', contextWindow: 128000, maxOutputTokens: 4096, config: { maxTokens: 4096 } }] }],
}))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = host
const key = createHash('sha256').update('dimcode:' + path.toNamespacedPath(await realpath(native))).digest('hex').slice(0, 32)
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\dim-rust-' + key : path.join(native, 'daemon.sock')
const daemon = spawn(binary, ['app-server', '--model-config', models, '--defaults', defaults, '--no-ws', '--home', native,
  process.platform === 'win32' ? '--pipe' : '--unix', endpoint], {
  cwd: workspace, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TMP: home, TEMP: home, TMPDIR: home,
    USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, DIMCODE_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const exited = new Promise<void>(resolve => daemon.once('close', () => resolve()))
const deadline = setTimeout(() => daemon.kill(), 45_000)
const startup = createInterface({ input: daemon.stdout })
daemon.stderr.resume()
const server = new DimaAppServer({ home, binary })
const owner = 'native-extension-fixture'
try {
  const [line] = await Promise.race([once(startup, 'line', { signal: AbortSignal.timeout(12_000) }),
    exited.then((): never => { throw new Error('Isolated daemon exited during startup') })])
  const ready = JSON.parse(line)
  assert.equal(ready.websocketAddress, null)
  assert.equal(process.platform === 'win32' ? ready.pipeName : ready.unixPath, endpoint)
  const [sessionId, secondId] = await withNativeRpc({ home, binary }, AbortSignal.timeout(8_000), async rpc => {
    await rpc.call('hello', { protocolVersion: 4, clientKind: 'other' })
    return [record(await rpc.call('session.create', { cwd: workspace })).sessionId,
      record(await rpc.call('session.create', { cwd: secondWorkspace })).sessionId]
  })
  const catalog = await server.catalog()
  const cwd = catalog.workspaces.find(w => w.sessions.some(s => s.sessionId === sessionId))?.cwd
  const second = catalog.workspaces.find(w => w.sessions.some(s => s.sessionId === secondId))?.cwd
  assert(cwd && second)
  const initial = await server.extensions({ cwd }, owner)
  assert(initial.items.every(item => !item.canToggle))
  assert(!JSON.stringify(initial).includes(sentinel))
  const mcp = initial.items.find(item => item.kind === 'mcp' && item.id === 'local-review')
  const skill = initial.items.find(item => item.kind === 'skill' && item.name === 'review' && item.source === 'project')
  const locked = initial.items.find(item => item.kind === 'plugin' && item.id === 'PluginManager')
  const notes = initial.items.find(item => item.kind === 'plugin' && item.id === 'notes')
  const common = initial.items.find(row => row.id === 'user:common' && row.source === 'user')
  const userMcp = initial.items.find(row => row.id === 'user-review' && row.source === 'user')
  assert(mcp && skill && locked && notes && common && userMcp, 'Missing seeded row in daemon output: ' + JSON.stringify(initial.items.map(({ kind, source, id }) => [kind, source, id])))
  assert.equal(typeof mcp.enabled, 'boolean', 'project MCP has native configured state')
  assert.equal(skill.enabled, true)
  assert.equal(mcp.scope, 'workspace')
  assert.equal(skill.scope, 'workspace')
  assert.equal(locked.scope, 'host')
  const grants = [mcp, skill, locked, notes, common, userMcp].map(({ kind, source, id, scope }) => ({ kind, id, source, ...(scope === 'workspace' ? { cwd } : {}) }))
  await writeFile(policy, JSON.stringify({ grants }), { mode: 0o600 })
  const approved = await server.extensions({ cwd }, owner)
  assert.equal(approved.items.find(row => row.id === skill.id)?.canToggle, true)
  assert.equal(approved.items.find(row => row.id === mcp.id)?.canToggle, true)
  assert.equal(approved.items.find(row => row.id === locked.id)?.canToggle, false, 'native PluginManager lock')
  const flip = ({ id, kind, source, scope, revision, enabled }: DimaExtension) => server.setExtension({
    id, kind, source, scope, revision, enabled: !enabled, operationId: randomUUID(), cwd,
  }, owner)
  for (const entry of [notes, common, userMcp, skill, mcp]) {
    const other = async (): Promise<DimaExtension> => (await server.extensions({ cwd: second }, owner)).items.find(row =>
      row.kind === entry.kind && row.name === entry.name && row.source === entry.source)!
    const prior = await other()
    assert.equal(prior.canToggle, entry.scope === 'host')
    const changed = (await flip(entry)).item
    assert.equal(changed.enabled, !entry.enabled)
    assert.notEqual(changed.revision, entry.revision)
    assert.equal((await other()).enabled, entry.scope === 'host' ? changed.enabled : prior.enabled)
    assert.equal((await flip(changed)).item.enabled, entry.enabled)
  }
  assert.equal(await readFile(path.join(workspace, '.mcp.json'), 'utf8'), mcpDocument)
  const preview = (await server.extensions({ cwd }, owner)).items.find(row => row.id === skill.id)!
  assert.equal(preview.canToggle, true)
  await writeFile(policy, JSON.stringify({ grants: [] }))
  await assert.rejects(flip(preview), { code: 'PERMISSION_DENIED' })
  const revoked = (await server.extensions({ cwd }, owner)).items.find(row => row.id === skill.id)
  assert.equal(revoked?.canToggle, false)
  assert.equal(revoked.enabled, preview.enabled)
  console.log('Native plugin, user and project Skill/MCP switches, cross-workspace scope, native locks and live file revocation passed.')
} finally {
  clearTimeout(deadline)
  server.dispose()
  startup.close()
  daemon.kill()
  await exited
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
