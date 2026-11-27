import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { dimaTasksOperations } from '@dsh-remote/protocol'
import type { NativeRpc } from '../src/dima/native-rpc.js'
import { conversationExport, goal, goalUpdate, taskDetail, tasks, tasksSupportedOperations, taskStop } from '../src/dima/tasks.js'

const view = { sessionId: 'leader', branchId: 'main' as const }
const target = { branchId: 'child', kind: 'command' as const, id: 'task-1' }
const hello = ['session.methods', 'session.stop', 'session.exec.stop', 'session.history', 'session.history.latestTurn', 'workflow.status', 'workflow.stop']
const names = ['session.exec.pending', 'session.exec.finished', 'session.exec.output', 'session.collaboration.pending', 'session.collaboration.finished', 'session.collaboration.cancel']
const run = { run_id: 'flow-1', name: 'Review', created_at: '2025-01-01T00:00:00Z', state: 'running', stages: [], log: [], started_by: { session_id: 'leader', branch_id: 'child' } }
const member = { eventId: 'request-1', startedAt: 11, request: { prompt: 'Inspect the selected input' }, delivery: { status: 'ok', session_id: 'member-owned', input_event_id: 'owned-input' } }
const command = { taskId: target.id, startedAt: 10, description: 'Background build' }
type Handler = (params: Record<string, unknown>) => unknown
function native(extra: Record<string, Handler> = {}) {
  const calls = vi.fn(async (method: string, p: Record<string, unknown>) => {
    if (extra[method]) return extra[method](p)
    if (method === 'session.methods') return { methods: names.map(name => ({ name })) }
    if (method === 'session.branches') return { branches: ['main', 'child'].map(branchId => ({ branchId, head: 23, state: 'open' })) }
    if (method.startsWith('session.exec.') && ['finished', 'pending'].includes(method.split('.').at(-1)!)) return { branchId: p.branchId, through: p.through, tasks: method.endsWith('pending') && p.branchId === 'child' ? [command] : [] }
    if (['session.collaboration.finished', 'session.collaboration.pending'].includes(method)) return { branchId: p.branchId, through: p.through, requests: p.branchId === 'child' && method.endsWith('pending') ? [member] : [] }
    if (method === 'workflow.status') return p.run_id ? run : [run, { ...run, run_id: 'private', started_by: { session_id: 'another-session', branch_id: 'child' }, name: 'private name' }]
    throw Error('Unexpected native method ' + method)
  })
  return { rpc: { call: calls } as unknown as NativeRpc, calls }
}
it('advertises installed hook discovery but rejects a selected Session without Goal before dispatch', async () => {
  expect(tasksSupportedOperations(['session.methods'])).toContain('goal')
  expect(tasksSupportedOperations([], names)).not.toContain('goal')
  const { rpc, calls } = native()
  await expect(goal(rpc, view, hello)).rejects.toMatchObject({ code: 'DIMA_INCOMPATIBLE' })
  expect(calls.mock.calls.map(([method]) => method)).toEqual(['session.methods'])
  const operationId = randomUUID()
  const supported = native({ 'session.methods': () => ({ methods: ['session.goal.get', 'session.goal.edit'].map(name => ({ name })) }), 'session.goal.edit': () => ({ sequence: 12 }), 'session.goal.get': () => ({ branchId: 'other', through: 12, goal: null }) })
  await expect(goalUpdate(supported.rpc, { ...view, action: 'edit', objective: 'updated', operationId }, hello)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
  expect(supported.calls).toHaveBeenCalledWith('session.goal.edit', { ...view, objective: 'updated' })
})
it('returns only owned task rows and revalidates the exact command or member before a stop', async () => {
  let cancelled = false
  const { rpc, calls } = native({ 'session.exec.stop': p => ({ task_id: p.taskId, status: 'cancelled' }),
    'session.collaboration.cancel': () => { cancelled = true; return { status: 'cancelled' } },
    'session.collaboration.pending': p => ({ branchId: p.branchId, through: p.through, requests: !cancelled && p.branchId === 'child' ? [member] : [] }),
    'session.collaboration.finished': p => ({ branchId: p.branchId, through: p.through, requests: cancelled && p.branchId === 'child' ? [{ start: member, result: { session_id: 'member-owned', request_event_id: member.eventId, status: 'cancelled', text: 'cancelled' } }] : [] }),
  })
  const inventory = await tasks(rpc, view, hello)
  expect(inventory.items.map(x => x.target.id).sort()).toEqual(['flow-1', 'request-1', 'task-1'])
  const operationId = randomUUID()
  for (const invalid of [{ ...target, branchId: 'main' }, { ...target, id: 'forged' }, { ...target, kind: 'member' as const, id: 'member-owned' }]) {
    await expect(taskStop(rpc, { ...view, operationId, target: invalid }, hello)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  }
  await expect(taskStop(rpc, { ...view, operationId, target }, hello)).resolves.toEqual({ ...view, target, operationId })
  expect(calls).toHaveBeenCalledWith('session.exec.stop', { sessionId: 'leader', branchId: 'child', taskId: 'task-1' })
  await taskStop(rpc, { ...view, target: { ...target, kind: 'member', id: 'request-1' }, operationId }, hello)
  expect(calls).toHaveBeenCalledWith('session.collaboration.cancel', { sessionId: 'leader', branchId: 'child', memberSessionId: 'member-owned' })
  expect(calls.mock.calls.filter(([m]) => m === 'session.stop')).toHaveLength(0)
})
it('rejects a completed command or reassigned workflow before native mutation', async () => {
  const { rpc, calls } = native({ 'workflow.status': p => p.run_id ? { ...run, started_by: 'management' } : [run],
    'session.exec.pending': p => ({ branchId: p.branchId, through: p.through, tasks: [] }),
    'session.exec.finished': p => ({ branchId: p.branchId, through: p.through, tasks: [{ start: command, end: { task_id: target.id, status: 'completed', result: { content: [] } } }] }),
  })
  for (const selected of [target, { ...target, kind: 'workflow' as const, id: run.run_id }]) {
    await expect(taskStop(rpc, { ...view, operationId: randomUUID(), target: selected }, hello)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  }
  expect(calls.mock.calls.some(([m]) => ['workflow.stop','session.exec.stop'].includes(m))).toBe(false)
})
it('limits member previews to the original delivered input', async () => {
  const { rpc } = native({ 'session.history': () => ({ events: [{ id: 'unrelated', type: 'input', name: 'message', data: { user: { content: [{ type: 'text', text: 'must stay private' }] } } }], done: true }) })
  const result = await taskDetail(rpc, { ...view, target: { ...target, id: 'request-1', kind: 'member' } }, hello)
  expect(result.text).toBe(member.request.prompt)
})
it('handles finished text results, bounded active output and ambiguous member records', async () => {
  const completed = native({ 'session.exec.pending': p => ({ branchId: p.branchId, through: p.through, tasks: [] }),
    'session.exec.finished': p => ({ branchId: p.branchId, through: p.through, tasks: [{ start: command, end: { task_id: target.id, status: 'completed', result: { content: 'native text' } } }] }),
  })
  expect((await taskDetail(completed.rpc, { ...view, target }, hello)).text).toBe('native text')
  const bounded = native({ 'session.exec.output.page': () => ({ text: 'first page', truncated: false, nextCursor: 65536 }) })
  expect(await taskDetail(bounded.rpc, { ...view, target }, [...hello, 'session.exec.output.page'])).toMatchObject({ text: 'first page', truncated: true })
  const ambiguous = native({ 'session.collaboration.pending': p => ({ branchId: p.branchId, through: p.through, requests: [member, { ...member, eventId: 'replacement' }] }) })
  await expect(taskStop(ambiguous.rpc, { ...view, operationId: randomUUID(), target: { ...target, kind: 'member', id: 'request-1' } }, hello)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  expect(ambiguous.calls.mock.calls.some(([m]) => m === 'session.collaboration.cancel')).toBe(false)
})
it('rejects repeated native task cursors and isolates a selected workflow stop', async () => {
  const invalid = native({ 'session.exec.pending': p => ({ branchId: p.branchId, through: p.through, tasks: [], next: { sequence: 1, entry: 2 } }) })
  await expect(tasks(invalid.rpc, view, hello)).rejects.toMatchObject({ code: 'DIMA_PROTOCOL_ERROR' })
  const live = native({ 'workflow.stop': p => ({ ...run, run_id: p.run_id, state: 'stopping' }) })
  const selected = { ...target, kind: 'workflow' as const, id: run.run_id }
  const operationId = randomUUID()
  expect(await taskStop(live.rpc, { ...view, target: selected, operationId }, hello)).toEqual({ ...view, target: selected, operationId })
  expect(live.calls).toHaveBeenCalledWith('workflow.stop', { run_id: run.run_id })
})
it('does not confirm a stop if work ended independently before the native reply', async () => {
  const operationId = randomUUID()
  const race = native({ 'session.exec.stop': p => ({ task_id: p.taskId, status: 'failed' }), 'session.collaboration.cancel': () => ({ status: 'idle' }), 'workflow.stop': () => ({ ...run, state: 'completed' }) })
  for (const chosen of [target, { ...target, kind: 'member' as const, id: 'request-1' }, { ...target, kind: 'workflow' as const, id: run.run_id }]) {
    await expect(taskStop(race.rpc, { ...view, target: chosen, operationId }, hello)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
  }
})
it('renders attachment labels and tool calls in Markdown without including a local file reference', async () => {
  const fixtures = [
    { type: 'input', name: 'message', data: { user: { content: [{ type: 'image', source: { type: 'file', mediaType: 'image/png', fileId: 'private-file-id' } }] } } },
    { type: 'step', name: 'thinking', data: { request_id: 'r', delta: 'consider' } },
    { type: 'step', name: 'tool-use', data: { call: { id: 'call', name: 'review', input: { mode: 'brief' } } } },
    { type: 'step', name: 'tool-result', data: { results: [{ call_id: 'call', result: { content: 'done' } }] } },
  ].map((event, index) => ({ sequence: index + 1, ...event }))
  const { rpc } = native({ 'session.history': () => ({ events: fixtures, nextAfter: 4, through: 4, done: true }) })
  const output = (await conversationExport(rpc, { ...view, format: 'markdown' }, hello)).text
  expect(output).toContain('[Image attachment: image/png]')
  expect(output).not.toContain('private-file-id')
  expect(output).toContain('### Reasoning')
  expect(output).toContain('Tool call: review (call)')
  expect(output).toContain('Tool result: call')
})
it('pins full export, keeps unknown events, and refuses oversized or inconsistent snapshots', async () => {
  const first = { sequence: 1, type: 'future', name: 'extra', preserved: [7], data: null }
  const end = { sequence: 2, type: 'branch', name: 'create-failed', data: { branch: 'child' } }
  const { rpc, calls } = native({ 'session.history': p => p.after === 0 ? { through: 2, nextAfter: 1, done: false, events: [first] } : { through: 2, nextAfter: 2, done: true, events: [end] } })
  const result = await conversationExport(rpc, { ...view, format: 'json' }, hello)
  expect(JSON.parse(result.text)).toEqual({ ...view, through: 2, events: [first, end] })
  expect(calls.mock.calls.at(-1)?.[1]).toEqual({ ...view, after: 1, through: 2, limit: 128 })
  expect((await conversationExport(rpc, { ...view, format: 'markdown' }, hello)).text).toContain('Child branch child was not created.')
  for (const [nextAfter, body] of [[0, 'short'], [1, 'x'.repeat(1_048_576)]] as const) {
    const invalid = native({ 'session.history': () => ({ through: 1, done: true, nextAfter, events: [{ ...first, body }] }) })
    await expect(conversationExport(invalid.rpc, { ...view, format: 'json' }, hello)).rejects.toThrow()
  }
  expect(dimaTasksOperations.goalUpdate.request.safeParse({ ...view, action: 'set', objective: 'x'.repeat(4001), operationId: randomUUID() }).success).toBe(false)
  expect(dimaTasksOperations.conversationExport.request.safeParse({ ...view, branchId: 'child', format: 'json' }).success).toBe(false)
  expect(dimaTasksOperations.taskStop.request.safeParse({ ...view, target, memberSessionId: 'injected', operationId: randomUUID() }).success).toBe(false)
})
