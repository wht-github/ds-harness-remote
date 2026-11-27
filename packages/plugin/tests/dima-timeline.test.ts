import { describe, expect, it, vi } from 'vitest'
import { dimaTimelineSchema, mergeDimaTimelinePages, type DimaTimeline } from '@dsh-remote/protocol'
import type { NativeRpc } from '../src/dima/native-rpc.js'
import { readDimaTimeline } from '../src/dima/timeline.js'
import { projectTimeline } from '../src/dima/timeline-projection.js'

const target = { sessionId: 's', branchId: 'child' }
const features = ['session.attach.expectedCwd', 'session.model.progress', 'session.history.display.tail', 'session.history.display.transcript']
const ctx = { cwd: '/project', state: 'open', instanceId: 'daemon', features }
const evt = (sequence: number, type: string, name: string, data: object) => ({ sequence, type, name, data, id: 'e' + sequence })
const owner = { turn_id: 'turn', request_id: 'request' }
const text = (seq: number, delta: string) => evt(seq, 'step', 'text', { ...owner, delta })
const input = (seq: number, s: string) => evt(seq, 'input', 'message', { user: { content: [{ type: 'text', text: s }] } })
const notice = (method: string, data: object, branchId = target.branchId) => ({ method, params: { ...target, branchId, ...data } })
const state = notice('session.state', { running: true, stopping: false })
const progress = (s: string, part = 'e1') => ({ turnId: 'turn', requestId: 'request', text: s,
  textPartId: part, textOffset: 0, thinking: '', thinkingOffset: 0, tools: [] })
const window = (events: ReturnType<typeof evt>[], from: number, to: number, through: number,
  live?: Record<string, unknown>): DimaTimeline => ({ ...target, from, to, through, instanceId: ctx.instanceId,
  ...(from && { earlier: { ...target, instanceId: ctx.instanceId, through, before: from } }), ...projectTimeline(events, live, to) })

describe('native DimAgent branch timeline', () => {
  it('preserves an interleaved queued input, coalesces overlapping history, and resolves the input to its consuming turn', () => {
    const earlier = window([text(1, 'A'), input(2, 'queue'), text(3, 'B')], 0, 3, 5)
    const later = window([text(3, 'B'), evt(4, 'input', 'consumed', { input_id: 'e2' }), text(5, 'C')], 3, 5, 5)
    const merged = mergeDimaTimelinePages(earlier, later)
    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0].blocks.map(b => [b.kind, b.id, b.text])).toEqual([['text', 'e1', 'ABC'], ['user', 'e2', 'queue']])
    expect(mergeDimaTimelinePages(merged, later)).toEqual(merged)
    expect(dimaTimelineSchema.safeParse(merged).success).toBe(true)
  })
  it('preserves the native tool id across overlapping pages and only shows the selected model output', () => {
    const a = window([evt(1, 'step', 'tool-use', { ...owner, call: { id: 'tool', name: 'edit', input: { path: 'file' } } })], 0, 1, 4)
    const b = window([evt(2, 'step', 'tool-completed', { ...owner, call_id: 'tool', result: { isError: false, content: 'edited', structuredContent: { diff: '@@' } } }),
      evt(3, 'step', 'text', { ...owner, delta: 'done' }), evt(4, 'turn', 'end', { turn_id: 'turn', status: 'completed' })], 2, 4, 4)
    expect(mergeDimaTimelinePages(a, b).turns[0].blocks[0]).toMatchObject({ sequence: 1, kind: 'tool', tool: 'edit', input: '{"path":"file"}', state: 'completed', output: 'edited', diff: '@@' })
    const start = evt(1, 'step', 'tool-use-start', { ...owner, call_id: 'tool', name: 'edit' })
    const streaming = window([start], 0, 1, 1, { ...progress(''), tools: [{ callId: 'tool', name: 'edit', arguments: '{"path"' }] })
    expect(streaming.turns[0].blocks[0]).toMatchObject({ input: '{"path"', liveInput: true })
    expect(mergeDimaTimelinePages(streaming, window([start], 0, 1, 1)).turns[0].blocks[0].input).toBeUndefined()
    const failed = projectTimeline([evt(1, 'step', 'tool-result', { ...owner, results: [{ call_id: 'tool', result: { isError: true, content: 'denied' } }] })], undefined, 1)
    expect(failed.turns[0].blocks[0]).toMatchObject({ state: 'failed', output: 'denied' })
    const stale = window([evt(1, 'step', 'model-output-end', owner), evt(2, 'turn', 'end', { ...owner, status: 'cancelled', reason: 'stop' })], 0, 2, 2, progress('discard'))
    expect(stale.turns[0]).toMatchObject({ blocks: [], status: 'cancelled', detail: 'stop' })
  })
  it('drops obsolete speculative text and merges real Unicode scalar offsets across a fresh attach', () => {
    const old = window([text(1, '🌱')], 0, 1, 1, progress('🌱before'))
    expect(old.turns[0].blocks[0].text).toBe('🌱before')
    const current = window([text(1, '🌱')], 0, 1, 1, progress('🌱after'))
    expect(mergeDimaTimelinePages(old, current).turns[0].blocks[0].text).toBe('🌱after')
    const settled = window([text(1, '🌱'), text(2, 'settled')], 0, 2, 2)
    expect(mergeDimaTimelinePages(current, settled).turns[0].blocks[0]).toMatchObject({ id: 'e1', text: '🌱settled' })
    const earlier = window([text(1, '🌱'), text(2, 'b')], 0, 2, 4)
    const resumed = window([input(3, 'queued')], 3, 4, 4, { ...progress('c'), textOffset: 2 })
    const resumedRows = mergeDimaTimelinePages(earlier, resumed).turns.flatMap(t => t.blocks)
    expect(resumedRows.filter(b => b.kind === 'text').map(b => b.text)).toEqual(['🌱bc'])
    const removed = mergeDimaTimelinePages(window([input(1, 'withdrawn')], 0, 1, 2), window([evt(2, 'input', 'deleted', { input_id: 'e1' })], 2, 2, 2))
    expect(removed.turns).toEqual([])
  })
  it('drains only the selected subscription, buffers events above the fixed head, and reuses native cursors without attaching older pages', async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>, receive: (n: Record<string, unknown>) => void) => {
      if (method === 'session.attach') return { cwd: ctx.cwd, sessionId: target.sessionId }
      if (params.before === 5) return { through: 5, nextAfter: 4, nextBefore: 1, done: true, items: [text(1, 'early')] }
      receive(notice('session.event', { event: text(6, 'after') }))
      receive(notice('session.event', { event: text(7, 'other') }, 'sibling'))
      receive(notice('session.model.progress', progress('latest', 'e8')))
      return { through: 5, nextAfter: 5, nextBefore: 5, done: false, items: [text(5, 'fixed')] }
    })
    const rpc = { call, notification: async () => state } as unknown as NativeRpc
    const page = await readDimaTimeline(rpc, target, ctx)
    expect(page).toMatchObject({ through: 5, to: 6, activity: { running: true }, earlier: { before: 5 } })
    expect(page.turns[0].blocks.map(b => b.text)).toEqual(['fixedafter', 'latest'])
    const older = await readDimaTimeline(rpc, { ...target, cursor: page.earlier }, ctx)
    expect(call.mock.calls.filter(c => c[0] === 'session.attach')).toHaveLength(1)
    expect(older.earlier).toBeUndefined()
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ through: 5, before: 5, tail: true })
    expect(mergeDimaTimelinePages(older, page).turns[0].blocks[0].text).toBe('earlyfixedafter')
  })
  it('crosses empty native display spans and keeps a real earlier cursor', async () => {
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (!params.before) return { through: 160, nextAfter: 160, done: true, items: [] }
      return { through: 160, nextAfter: 90, nextBefore: 90, done: false, items: [input(90, 'earlier visible message')] }
    })
    const page = await readDimaTimeline({ call } as unknown as NativeRpc, target, { ...ctx, state: 'ended' })
    expect(call.mock.calls[1][1]).toMatchObject({ through: 160, before: 97 })
    expect(page).toMatchObject({ through: 160, earlier: { before: 90 }, turns: [{blocks: [{text: 'earlier visible message'}]}] })
  })
  it('retains the entire long running turn, queues input across a page boundary, and advances older cursors across the memory limit', () => {
    const delta = '🌱'.repeat(16000)
    const events = Array.from({length: 8}, (_, i) => text(i + 1, delta))
    const a = window(events.slice(0, 5), 0, 5, 8)
    const b = window(events.slice(3), 4, 8, 8)
    const long = mergeDimaTimelinePages(a, b)
    expect(long.turns[0].blocks.map(x => x.text).join('')).toBe(delta.repeat(8))
    expect([...new Set(long.turns[0].blocks.flatMap(x => x.parts!.map(p => p.id)))]).toHaveLength(8)
    const pending = window([input(2, 'q'), evt(3, 'input', 'consumed', { input_id: 'e2' })], 0, 3, 5)
    const next = window([text(4, 'answer')], 4, 5, 5)
    expect(mergeDimaTimelinePages(pending, next).turns[0].blocks.map(b => b.kind)).toEqual(['user', 'text'])
    const page = (first: number) => window(Array.from({length: 16}, (_, i) => input(first + i, 'x'.repeat(21000))), first, first + 15, 160)
    let shown = page(145)
    for (let first = 129; first >= 1; first -= 16) {
      const previous = shown.earlier!.before
      shown = mergeDimaTimelinePages(page(first), shown)
      expect(shown.earlier!.before).toBeLessThan(previous)
      expect(shown.earlier!.before).toBe(first)
      expect(dimaTimelineSchema.safeParse(shown).success).toBe(true)
    }
  })
  it('resets a gapped window or restarted daemon, rejects crossed cursors and uses atomic raw cursors for legacy readers', async () => {
    const recent = window([text(15, 'latest')], 15, 15, 15)
    expect(mergeDimaTimelinePages(window([text(2, 'ancient')], 0, 2, 2), recent)).toBe(recent)
    expect(mergeDimaTimelinePages({ ...recent, instanceId: 'old' }, recent)).toBe(recent)
    const calls = vi.fn(async (method: string, _params: Record<string, unknown>) => method === 'session.attach'
      ? { sessionId: 's', cwd: ctx.cwd } : { through: 150, nextAfter: 150, nextBefore: 111, done: true,
        events: Array.from({ length: 40 }, (_, i) => text(111 + i, 'X')) })
    const rpc = { call: calls, notification: async () => state } as unknown as NativeRpc
    await expect(readDimaTimeline(rpc, { ...target, cursor: { ...recent.earlier!, branchId: 'sibling' } }, ctx)).rejects.toMatchObject({ code: 'DIMA_CURSOR_STALE' })
    expect(calls).not.toHaveBeenCalled()
    const old = await readDimaTimeline(rpc, target, { ...ctx, features: [...features.slice(0, 2), 'session.history.latestTurn'] })
    expect(old).toMatchObject({ through: 150, earlier: { through: 150, before: 111 } })
    expect(calls.mock.calls[1]).toMatchObject(['session.history', { latestTurn: true, limit: 32 }, expect.any(Function)])
  })
})
