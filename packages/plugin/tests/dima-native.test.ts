import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DimaAppServer } from '../src/dima/app-server.js'
import { RpcError } from '../src/safe-error.js'
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
  it('negotiates branch reads independently of submit and rejects unavailable writes before calling a native method', async () => {
    const partial = { ...hello, features: [...hello.features, 'session.methods', 'session.attach.expectedCwd'] }
    const calls = replay([partial, partial])
    const server = new DimaAppServer()
    try {
      expect(await server.features()).toMatchObject({ read: true, interaction: false, inbox: true, options: true,
        mediaSearch: true, mediaSubmit: false, mediaUpload: false, extensions: false, timeline: false })
      await expect(server.mediaSubmit({ ...request, requestId: 'c8d6a373-2031-4d94-a238-8811e54f045c', mode: 'queue',
        parts: [{ type: 'text', text: 'draft' }] }, 'device')).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' })
      expect(calls.map(call => call.method)).toEqual(['hello', 'hello'])
    } finally { server.dispose() }
  })

  it('keeps a recent verified handshake through transient load only until its original deadline', async () => {
    let now = 20_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    replay([hello])
    const server = new DimaAppServer()
    try {
      expect(await server.probe()).toBe(true)
      vi.mocked(native.withNativeRpc).mockRejectedValue(new RpcError('RATE_LIMITED', 'Busy'))
      now += 3000
      expect(await server.probe()).toBe(true)
      now += 8000
      expect(await server.probe()).toBe(false)
    } finally { server.dispose() }
  })

  it('serves concurrent device reads in bounded native slots and discards disconnected waiters', async () => {
    let resume!: () => void
    const busy = new Promise<void>(resolve => { resume = resolve })
    const connections = vi.spyOn(native, 'withNativeRpc').mockImplementation(async () => { await busy; throw native.unavailable() })
    const server = new DimaAppServer()
    const keep = new AbortController()
    const disconnected = new AbortController()
    const read = (signal: AbortSignal) => server.inbox(request, 'phone', signal).catch(error => error.code)
    try {
      const first = Array.from({ length: 4 }, () => read(keep.signal))
      await vi.waitFor(() => expect(connections).toHaveBeenCalledTimes(4))
      const cancelled = read(disconnected.signal)
      const waiting = read(keep.signal)
      disconnected.abort()
      expect(await cancelled).toBe('TRANSPORT_CLOSED')
      expect(connections).toHaveBeenCalledTimes(4)
      resume()
      await Promise.all([...first, waiting])
      expect(connections).toHaveBeenCalledTimes(5)
    } finally { resume(); server.dispose() }
  })

  it('reads new replies across whole native batches at one fixed head, including a terminal failure', async () => {
    const head = 30_000
    const batch = Array.from({ length: 130 }, (_, offset) => ({ sequence: head - 130 + offset, type: 'step', name: 'thinking' }))
    const ended = { sequence: head, type: 'turn', name: 'end', data: { status: 'failed', error: 'provider unavailable' } }
    const first = { ...page([...batch, ended], head), nextBefore: head - 130 }
    const earlier = { ...page([
      input(head - 140, [{ type: 'text', text: 'latest input' }]), text(head - 135, 'new '),
      input(head - 134, [{ type: 'text', text: 'queued' }]), text(head - 132, 'reply'),
    ], head - 131, head), nextBefore: head - 200 }
    const calls = replay([hello, catalog, branches, first, earlier])
    expect(await new DimaAppServer().history({ ...request, window: 'recent' })).toEqual({ ...request, truncated: true,
      messages: [{ role: 'user', text: 'latest input' }, { role: 'assistant', text: 'new reply' }, { role: 'user', text: 'queued' }],
      lastTurnIssue: { status: 'failed', detail: 'provider unavailable' },
    })
    expect(calls.slice(-2).map(c => c.params)).toEqual([
      { ...request, latestTurn: true, limit: 128 },
      { ...request, before: head - 130, through: head, limit: 128 },
    ])
  })

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

describe('native v4 branch interaction contract (arcships/dim v0.1.0-alpha.29)', () => {
  const target = { sessionId: 's1', branchId: 'feature' }
  const cwd = process.cwd()
  const owner = 'device-1'
  const question = { ...target, requestId: 'approval-1', reason: 'Review fixture operation', call: { name: 'sample', input: { value: '中' } } }
  const state = { ...target, running: true, stopping: false }
  const notice = (method: string, params: unknown) => ({ jsonrpc: '2.0', method, params })

  function fixture() {
    const feed: Array<Record<string, unknown>> = []
    const calls: { method: string; params: Record<string, unknown> }[] = []
    let pending: typeof question | undefined = structuredClone(question)
    let instanceId = 'daemon-a'
    let status = { ...state }
    let features = [...hello.features, 'session.create', 'session.submit', 'session.input_lookup', 'session.stop', 'session.attach.expectedCwd', 'session.history.latestTurn']
    const nativeError = new Error('unavailable')
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      switch (method) {
        case 'hello': return { ...hello, features, instanceId }
        case 'session.catalog': return { sessions: [{ sessionId: target.sessionId, cwd }] }
        case 'session.branches': return { defaultBranchId: 'main', branches: ['main', 'feature'].map(branchId => ({ branchId, state: 'open' })) }
        case 'session.attach':
          feed.length = 0
          expect(params).toEqual({ sessionId: target.sessionId, expectedCwd: cwd })
          feed.push(notice('approval.request', { ...question, branchId: 'main', requestId: 'sibling-approval' }))
          if (pending) feed.push(notice('approval.request', pending))
          feed.push(notice('session.state', { ...state, branchId: 'main', running: false }), notice('session.state', status))
          return { sessionId: target.sessionId, cwd }
        case 'approval.respond':
          expect(params).toMatchObject({ ...target, requestId: pending?.requestId })
          pending = undefined
          return {}
        case 'session.stop': return { sequence: 19 }
        case 'session.input_lookup': return { status: 'unknown' }
        case 'session.submit': throw nativeError
        case 'session.create': throw nativeError
        default: throw new Error('Unexpected test RPC ' + method)
      }
    })
    vi.spyOn(native, 'withNativeRpc').mockImplementation(async (_options, signal, run) => {
      const rpc = {
        call: invoke,
        notification: async () => {
          const frame = feed.shift()
          if (frame) return frame
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          throw nativeError
        },
      }
      return run(rpc as unknown as native.NativeRpc)
    })
    return { server: new DimaAppServer(), calls,
      setPending: (value: typeof pending) => { pending = value },
      setStatus: (value: typeof state) => { status = value },
      replaceDaemon: () => { instanceId = 'daemon-b' },
      readOnly: () => { features = [...hello.features] },
    }
  }

  it.each(['allow', 'deny'] as const)('binds complete pending details, owner and branch to a single %s', async decision => {
    const f = fixture()
    const approval = { ...target, requestId: question.requestId, decision }
    expect(await f.server.interactionAvailable()).toBe(true)
    expect(f.calls.map(c => c.method)).toEqual(['hello'])
    await expect(f.server.respond(approval, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    expect(await f.server.status(target, owner)).toEqual({ ...state, approvals: [{ requestId: question.requestId, tool: 'sample', reason: question.reason, input: JSON.stringify(question.call.input) }] })
    await expect(f.server.respond(approval, 'another-device')).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    await expect(f.server.respond({ ...approval, requestId: 'sibling-approval' }, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    f.setPending({ ...question, call: { name: 'sample', input: { value: 'changed' } } })
    await expect(f.server.respond(approval, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    await f.server.status(target, owner)
    f.replaceDaemon()
    await expect(f.server.respond(approval, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    await f.server.status(target, owner)
    await expect(f.server.respond(approval, owner)).resolves.toEqual({ ...target, requestId: question.requestId })
    await expect(f.server.respond(approval, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_STALE' })
    expect(f.calls.filter(c => c.method === 'approval.respond')).toEqual([{ method: 'approval.respond', params: approval }])
  })

  it('refuses an approval with incomplete display and aborts a missing selected state on disposal', async () => {
    const f = fixture()
    f.setPending({ ...question, call: { name: 'sample', input: { value: 'x'.repeat(40_000) } } })
    await expect(f.server.status(target, owner)).rejects.toMatchObject({ code: 'DIMA_APPROVAL_TOO_LARGE' })
    await expect(f.server.interrupt(target, owner)).resolves.toEqual(target)
    expect(f.calls.filter(c => c.method === 'session.stop')).toEqual([{ method: 'session.stop', params: target }])
    f.setPending(undefined)
    f.setStatus({ ...state, branchId: 'main' })
    const missing = expect(f.server.status(target, owner)).rejects.toMatchObject({ code: 'DIMA_UNAVAILABLE' })
    await new Promise(resolve => setImmediate(resolve))
    f.server.dispose()
    await missing
    expect(await f.server.interactionAvailable()).toBe(false)
    expect(f.calls.some(c => c.method === 'approval.respond')).toBe(false)
  })

  it('deduplicates in-flight and unknown creates/submissions without repeating the mutation', async () => {
    const f = fixture()
    const requestId = '00112233-4455-4677-8899-aabbccddeeff'
    const submit = { ...target, requestId, text: 'once only' }
    const outcomes = await Promise.allSettled([f.server.submit(submit, owner), f.server.submit(submit, owner)])
    expect(outcomes).toEqual(Array(2).fill({ status: 'rejected', reason: expect.objectContaining({ code: 'DIMA_OUTCOME_UNKNOWN' }) }))
    await expect(f.server.submit({ ...submit, text: 'different' }, owner)).rejects.toMatchObject({ code: 'DIMA_REQUEST_CONFLICT' })
    await expect(f.server.submit(submit, owner)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    for (let i = 0; i < 2; i++) await expect(f.server.create({ cwd, requestId }, owner)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
    expect(f.calls.filter(c => c.method === 'session.submit')).toEqual([{ method: 'session.submit', params: { ...target, submissionId: requestId, mode: 'queue', text: submit.text } }])
    await expect(f.server.create({ cwd: path.dirname(cwd), requestId: 'a0112233-4455-4677-8899-aabbccddeeff' }, owner)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
    expect(f.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
  })

  it('negotiates read-only support separately and never writes or attaches without the interaction features', async () => {
    const f = fixture()
    f.readOnly()
    expect(await f.server.probe()).toBe(true)
    expect(await f.server.interactionAvailable()).toBe(false)
    await expect(f.server.interrupt(target, owner)).rejects.toMatchObject({ code: 'DIMA_INCOMPATIBLE' })
    expect(f.calls.every(c => c.method === 'hello')).toBe(true)
  })
})
