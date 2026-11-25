import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DimaAppServer } from '../src/dima/app-server.js'
import * as native from '../src/dima/native-rpc.js'

const cwd = path.resolve('DimAgent test workspace')
const request = { sessionId: 'session-1', branchId: 'review' }
const hello = { instanceId: 'instance', serverVersion: 'native', protocolVersion: 4, features: ['session.catalog', 'session.history', 'session.branches'] }
const catalog = { sessions: [{ cwd, sessionId: request.sessionId, title: null, preview: 'Native session' }] }
const branches = { defaultBranchId: 'review', branches: [{ branchId: 'main' }, { branchId: 'review' }] }
const text = (sequence: number, delta: string) => ({ sequence, type: 'step', name: 'text', data: { request_id: 'response-1', delta } })
const input = (sequence: number, content: unknown[]) => ({ sequence, type: 'input', name: 'message', data: { user: { content } } })
const page = (events: unknown[], nextAfter: number, through = nextAfter) => ({ events, through, nextAfter, done: nextAfter === through })

function replay(results: unknown[]) {
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = []
  const writer = new Writable({ write(chunk, _encoding, done) { calls.push(JSON.parse(chunk.toString())); done() } })
  const data = results.map((result, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, result }) + '\n').join('')
  const rpc = new native.NativeRpc(Readable.from([Buffer.from(data)]), writer)
  vi.spyOn(native, 'withNativeRpc').mockImplementation((_options, _signal, work) => work(rpc))
  return calls
}

afterEach(() => vi.restoreAllMocks())

describe('native DimAgent read authority', () => {
  it('probes only the versioned hello and requires all three read capabilities', async () => {
    const calls = replay([hello])
    const server = new DimaAppServer()
    expect(await Promise.all(Array.from({ length: 8 }, () => server.probe()))).toEqual(Array(8).fill(true))
    expect(await server.probe()).toBe(true)
    expect(calls.map(({ method, params }) => [method, params])).toEqual([
      ['hello', { protocolVersion: 4, clientKind: 'other', clientName: 'ds-harness-remote' }],
    ])
    replay([{ ...hello, features: ['session.catalog', 'session.history'] }])
    expect(await new DimaAppServer().probe()).toBe(false)
    replay([{ ...hello, protocolVersion: 3 }])
    await expect(new DimaAppServer().catalog()).rejects.toMatchObject({ code: 'DIMA_INCOMPATIBLE' })
  })

  it('groups daemon catalog pages and keeps the confirmed default branch first', async () => {
    const calls = replay([hello, { ...catalog, nextCursor: 'second-page' }, branches,
      { sessions: [{ cwd, sessionId: 'second', title: 'Other session' }] }, { defaultBranchId: 'only', branches: [{ branchId: 'only' }] }])
    expect(await new DimaAppServer().catalog()).toEqual({ workspaces: [{ cwd, sessions: [
      { sessionId: request.sessionId, title: 'Native session', branches: ['review', 'main'] },
      { sessionId: 'second', title: 'Other session', branches: ['only'] },
    ] }] })
    expect(calls.map(c => c.method)).toEqual(['hello', 'session.catalog', 'session.branches', 'session.catalog', 'session.branches'])
    expect(calls[3].params.cursor).toBe('second-page')
  })

  it('reads the requested branch through a fixed watermark and projects only operator and model text', async () => {
    const calls = replay([hello, catalog, branches, page([
      { sequence: 1, type: 'input', name: 'message', data: { blocks: [{ text: 'runtime prompt' }] } },
      input(2, [{ type: 'text', text: '你好' }, { type: 'image', source: {} }, { type: 'text', text: '<dim-hooks>hidden</dim-hooks>' }]),
      text(3, '复'),
    ], 3, 7), page([
      { sequence: 4, type: 'step', name: 'thinking', data: { delta: 'private' } },
      { sequence: 5, type: 'extension', name: 'metadata', data: null },
      { ...text(6, 'nested'), parent_call_id: 'tool' }, text(7, '核'),
    ], 7)])
    expect(await new DimaAppServer().history(request)).toEqual({ ...request,
      messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '复核' }], truncated: false })
    expect(calls.slice(3).map(c => c.params)).toEqual([
      { ...request, after: 0, limit: 128 }, { ...request, after: 3, through: 7, limit: 128 },
    ])
  })

  it.each([
    ['session outside the catalog', [hello, { sessions: [] }], 'DIMA_NOT_FOUND'],
    ['branch outside the directory', [hello, catalog, { defaultBranchId: 'main', branches: [{ branchId: 'main' }] }], 'DIMA_NOT_FOUND'],
    ['unconfirmed default branch', [hello, catalog, { defaultBranchId: 'missing', branches: [] }], 'DIMA_PROTOCOL_ERROR'],
  ] as const)('refuses %s before asking for events', async (_name, results, code) => {
    const calls = replay([...results])
    await expect(new DimaAppServer().history(request)).rejects.toMatchObject({ code })
    expect(calls.some(c => c.method === 'session.history')).toBe(false)
  })

  it.each([
    ['stalled cursor', [{ events: [], through: 10, nextAfter: 0, done: false }]],
    ['changed watermark', [page([], 4, 8), page([], 9)]],
    ['out of order events', [page([text(2, 'b'), text(1, 'a')], 2)]],
    ['malformed event', [page([{ ...text(1, 'a'), data: { delta: 'missing request id' } }], 1)]],
  ])('rejects a native history page with %s', async (_name, pages) => {
    replay([hello, catalog, branches, ...pages])
    await expect(new DimaAppServer().history(request)).rejects.toMatchObject({ code: 'DIMA_PROTOCOL_ERROR' })
  })

  it('rejects a catalog with a repeated cursor and never substitutes an empty result', async () => {
    const page = (sessionId: string) => ({ sessions: [{ cwd, sessionId, title: sessionId }], nextCursor: 'stuck' })
    replay([hello, page('one'), branches, page('two'), branches])
    await expect(new DimaAppServer().catalog()).rejects.toMatchObject({ code: 'DIMA_PROTOCOL_ERROR' })
  })

  it('keeps even heavily escaped UTF-8 history within the serialized limit', async () => {
    replay([hello, catalog, branches, page([text(1, 'first'), text(2, '\0'.repeat(350_000))], 2)])
    const result = await new DimaAppServer().history(request)
    expect(result.truncated).toBe(true)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].text.startsWith('first\0')).toBe(true)
    expect(result.messages[0].text.length).toBeLessThan(350_005)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('reports a missing daemon without creating its product home', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'dima-no-daemon-'))
    try {
      const server = new DimaAppServer({ home: path.join(temp, 'missing') })
      expect(await server.probe()).toBe(false)
      await expect(server.catalog()).rejects.toMatchObject({ code: 'DIMA_UNAVAILABLE' })
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
})

describe('native DimAgent NDJSON', () => {
  const sink = () => new Writable({ write(_chunk, _encoding, done) { done() } })
  it('correlates a split UTF-8 response across a notification frame', async () => {
    const data = Buffer.from('{"jsonrpc":"2.0","method":"update"}\n{"jsonrpc":"2.0","id":1,"result":"分支"}\r\n')
    const split = data.indexOf(Buffer.from('分')) + 1
    const rpc = new native.NativeRpc(Readable.from([data.subarray(0, split), data.subarray(split)]), sink())
    await expect(rpc.call('hello', {})).resolves.toBe('分支')
  })

  it('rejects an oversized unterminated frame while receiving it', async () => {
    const chunks = [Buffer.alloc(8 * 1024 * 1024, 32), Buffer.from(' ')]
    const rpc = new native.NativeRpc(Readable.from(chunks), sink())
    await expect(rpc.call('hello', {})).rejects.toMatchObject({ code: 'DIMA_LIMIT_EXCEEDED' })
  })

  it.each([
    ['wrong response id', '{"jsonrpc":"2.0","id":2,"result":null}\n', 'DIMA_PROTOCOL_ERROR'],
    ['ambiguous response', '{"jsonrpc":"2.0","id":1,"result":null,"error":{}}\n', 'DIMA_PROTOCOL_ERROR'],
    ['unterminated response', '{"jsonrpc":"2.0"', 'DIMA_PROTOCOL_ERROR'],
    ['native error', '{"jsonrpc":"2.0","id":1,"error":{"message":"secret"}}\n', 'DIMA_REQUEST_FAILED'],
  ])('rejects %s using a non-sensitive error', async (_name, data, code) => {
    const rpc = new native.NativeRpc(Readable.from([Buffer.from(data)]), sink())
    await expect(rpc.call('hello', {})).rejects.toMatchObject({ code, message: expect.not.stringContaining('secret') })
  })
})
