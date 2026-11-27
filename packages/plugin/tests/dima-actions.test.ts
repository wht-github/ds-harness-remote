import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { dimaActionRequestSchema, type DimaActionRequest } from '@dsh-remote/protocol'
import { RpcError } from '../src/safe-error.js'
import { DimaActions } from '../src/dima/actions.js'
import type { ActionRpc } from '../src/dima/actions-state.js'

const target = { sessionId: 'session', branchId: 'review' }
const ctx = { owner: 'phone', instanceId: 'daemon', state: 'open', features: ['session.methods', 'session.input.pending.blockPresence'] }
const methods = (decl: Record<string, boolean>) => ({ methods: Object.entries(decl).map(([name, mutating]) => ({ name, mutating })) })
const typed = (req: Record<string, unknown>) => dimaActionRequestSchema.parse({ ...target, operationId: randomUUID(), ...req })
const question = (eventId: string, sequence: number, prompt: string) => ({ eventId, sequence, requestId: 'request-' + sequence, calls: [
  { id: 'call', name: 'ask_user', input: { questions: [{ header: '', question: prompt, options: [{ label: 'A', description: '' }, { label: 'B' }] }] } },
] })
const page = (rows: unknown[], next: unknown = null, through = 5) => ({ branchId: target.branchId, through, batches: rows, next })
const answerRequest = (overrides: Record<string, unknown> = {}) => typed({ kind: 'answer', eventId: 'b', requestId: 'request-3', callId: 'call',
  answers: [{ questionId: '1', selected: ['A'] }], ...overrides })

function rpc(handler: ActionRpc['call']) { return { call: vi.fn(handler) } }

describe('native branch controls', () => {
  it('fixes each inventory cutoff, validates answers against current complete forms and binds review to branch, daemon and device', async () => {
    const actions = new DimaActions()
    const cursor = { sequence: 2 }
    let prompt = 'Which?'
    const wire = rpc(async (method, args) => {
      if (method === 'session.methods') return methods({ 'session.question.pending': false, 'session.question.respond': true })
      if (method === 'session.question.respond') return {}
      if (method !== 'session.question.pending') throw Error(method)
      if (!args.after) return page([question('a', 2, 'First?')], cursor)
      expect(args).toEqual({ ...target, through: 5, after: cursor })
      return page([question('b', 3, prompt)])
    })
    const snap = await actions.inbox(wire, target, ctx)
    expect(snap.questions.map(q => q.eventId)).toEqual(['a','b'])
    expect(snap.questions[1].questions[0]).toMatchObject({ id: '1', multiSelect: false, allowCustom: true })
    for (const foreign of [{ ...ctx, owner: 'tablet' }, { ...ctx, instanceId: 'other' }])
      await expect(actions.act(wire, answerRequest(), foreign)).rejects.toMatchObject({ code: 'DIMA_ACTION_STALE' })
    for (const answers of [[{ questionId: '1', selected: ['C'] }], [{ questionId: '1', selected: ['A'], custom: 'extra' }],
      [{ questionId: '1', selected: ['A','B'] }], [{ questionId: '1', selected: [] }], [{ questionId: 'absent', selected: ['A'] }]])
      await expect(actions.act(wire, answerRequest({ answers }), ctx)).rejects.toMatchObject({ code: 'DIMA_INVALID_ANSWER' })
    prompt = 'Changed after review'
    await expect(actions.act(wire, answerRequest(), ctx)).rejects.toMatchObject({ code: 'DIMA_ACTION_STALE' })
    expect(wire.call.mock.calls.filter(([m]) => m === 'session.question.respond')).toHaveLength(0)
    await actions.inbox(wire, target, ctx)
    const req = answerRequest({ answers: undefined, declined: true })
    const [first, repeated] = await Promise.all([actions.act(wire, req, ctx), actions.act(wire, req, ctx)])
    expect(first).toEqual(repeated)
    expect(wire.call.mock.calls.filter(([m]) => m === 'session.question.respond')).toEqual([['session.question.respond', {
      ...target, requestId: 'request-3', callId: 'call', declined: true,
    }]])
    await expect(actions.act(wire, answerRequest({ operationId: req.operationId }), ctx)).rejects.toMatchObject({ code: 'DIMA_REQUEST_CONFLICT' })
  })

  it('rejects swapped branches, changing cutoffs, reversed rows, repeated cursors and oversized pages before writing', async () => {
    const first = page([question('a', 2, 'First')], { seq: 2 })
    const bad = [{ ...first, branchId: 'main' }, page([question('b', 4, 'Next')], null, 6), page([question('b', 1, 'Next')]),
      page([question('b', 3, 'Next')], { seq: 2 }), page([question('b', 4, 'x'.repeat(2 * 1024 * 1024))])]
    for (const value of bad) {
      const wire = rpc(async (m, p) => m === 'session.methods' ? methods({ 'session.question.pending': false }) : p.after ? value : first)
      await expect(new DimaActions().inbox(wire, target, ctx)).rejects.toBeInstanceOf(RpcError)
      expect(wire.call).toHaveBeenCalledTimes(3)
    }
  })

  it('restores only deleted single exact text, preserves full atomic steer payload and excludes automatic or applied inputs', async () => {
    const actions = new DimaActions()
    const input = (sequence: number, content: unknown[]) => ({ sequence, inputId: String(sequence), mode: 'queue', hasRawBlocks: false, applied: false, user: { content } })
    const text = { type: 'text', text: ' checked spacing ' }
    const rich = { type: 'image', attachment: 'ref' }
    const entries = [input(1, [text]), input(2, [text, rich]), { ...input(3, [text]), applied: true }, { ...input(4, [text]), user: null, hasRawBlocks: true }]
    let status = 'notHeld'
    const wire = rpc(async m => m === 'session.methods' ? methods({ 'session.input.pending': false, 'session.input.withdraw': true })
      : m === 'session.input.pending' ? { branchId: target.branchId, through: 5, next: null, inputs: entries } : { status })
    const inbox = await actions.inbox(wire, target, ctx)
    expect(inbox.queue.map(i => [i.inputId, i.editable])).toEqual([['1', true], ['2', false]])
    await expect(actions.act(wire, typed({ kind: 'retrieve', inputId: '2' }), ctx)).rejects.toMatchObject({ code: 'DIMA_ACTION_STALE' })
    await expect(actions.act(wire, typed({ kind: 'retrieve', inputId: '1' }), ctx)).rejects.toMatchObject({ code: 'DIMA_INPUT_NOT_HELD' })
    status = 'deleted'
    expect((await actions.act(wire, typed({ kind: 'retrieve', inputId: '1' }), ctx)).restoredText).toBe(text.text)
    await actions.act(wire, typed({ kind: 'steerQueued', inputId: '2' }), ctx)
    expect(wire.call.mock.lastCall).toEqual(['session.input.withdraw', { ...target, inputId: '2', steer: { content: [text,rich] } }])
  })

  it('reads scoped media and write capabilities from exact declarations, skips ended branches and never accepts hello spoofing a Session writer', async () => {
    const actions = new DimaActions()
    const wire = rpc(async () => methods({ 'attachment.import': false, 'attachment.put': true, 'session.files.search': false,
      'session.input.withdraw': false, 'session.rename': false, 'session.question.respond': false }))
    const result = await actions.inbox(wire, target, { ...ctx, features: [...ctx.features, 'attachment.import','session.rename','session.question.respond'] })
    expect(result.media).toEqual({ image: false, paste: true, file: true })
    expect(result.actions).toEqual([])
    const before = wire.call.mock.calls.length
    expect((await actions.inbox(wire, target, { ...ctx, state: 'ended' })).actions).toEqual([])
    expect(wire.call).toHaveBeenCalledTimes(before)
  })

  it('bounds the encoded size of native answers before transport, including escaped text', () => {
    const request = { ...target, operationId: randomUUID(), kind: 'answer', requestId: 'r', eventId: 'e', callId: 'c',
      answers: Array.from({ length: 4 }, (_, i) => ({ questionId: String(i), selected: [], custom: '\u0001'.repeat(65_536) })) }
    expect(dimaActionRequestSchema.safeParse(request).success).toBe(false)
  })

  it('validates effort against the current selection, preserves unrelated preferences, and does not replay unacknowledged writes', async () => {
    const actions = new DimaActions()
    const features = [...ctx.features, 'session.model.get','session.model.update','provider.models.query']
    let allow = true
    const wire = rpc(async (m) => {
      if (m === 'session.methods') return methods({ 'session.context.usage': false })
      if (m === 'session.context.usage') throw new RpcError('DIMA_USAGE_UNAVAILABLE', 'No estimate yet.')
      if (m === 'session.model.get') return { branchId: target.branchId, through: 6, configuration: { model: { providerId: 'route', modelId: 'm' },
        catalogProviderId: 'catalog', modelPreferences: { reasoningEffort: 'low', serviceTier: 'priority' }, capabilitySnapshot: {
          target: { providerId: 'route', modelId: 'm' }, capabilities: { reasoning: true }, reasoning: { supported: true, effortOptions: ['low','high'], off: {} },
        } } }
      if (m === 'provider.models.query') return { models: [{ providerId: 'catalog', model: { id: 'm', name: 'Selected' } }], next: null }
      if (m === 'session.model.update' && allow) return { outcome: 'adopted', model: { modelId: 'm', providerId: 'route' } }
      throw Error('disconnected')
    })
    const device = { ...ctx, features }
    const options = await actions.options(wire, target, device)
    expect(options).toMatchObject({ model: { provider: 'catalog', modelId: 'm' }, effort: 'low', models: [{ efforts: ['low','high','none'] }] })
    expect(options.usage).toBeUndefined()
    await expect(actions.act(wire, typed({ kind: 'setEffort', effort: 'made-up' }), device)).rejects.toMatchObject({ code: 'DIMA_ACTION_STALE' })
    await actions.act(wire, typed({ kind: 'setEffort', effort: 'high' }), device)
    expect(wire.call).toHaveBeenCalledWith('session.model.update', { ...target, modelPreferences: { reasoningEffort: 'high' } })
    expect(wire.call.mock.lastCall).toEqual(['session.model.get', target])
    allow = false
    const request: DimaActionRequest = typed({ kind: 'setModel', provider: 'catalog', modelId: 'm' })
    await expect(actions.act(wire, request, device)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    const writes = wire.call.mock.calls.length
    await expect(actions.act(wire, request, device)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    expect(wire.call).toHaveBeenCalledTimes(writes)
  })
})
