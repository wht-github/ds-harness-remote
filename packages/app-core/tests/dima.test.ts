import { expect, it, vi } from 'vitest'
import { createDimaClient, stopWithDimaDraft } from '../src/services/dima'

it('rejects unsupported operations, stale connections and wrong workspace receipts', async () => {
  const signal = new AbortController().signal
  const rpc = vi.fn()
  let authorized = false
  const client = createDimaClient(rpc, () => true, () => authorized)
  await expect(client.operation('extensions', {cwd:'/project'}, signal)).rejects.toThrow()
  expect(rpc).not.toHaveBeenCalled()
  authorized = true
  rpc.mockResolvedValueOnce({cwd:'/other',items:[]})
  await expect(client.operation('extensions', {cwd:'/project'}, signal)).rejects.toThrow()
  rpc.mockImplementationOnce(async () => { authorized=false; return {cwd:'/project',items:[]} })
  await expect(client.operation('extensions', {cwd:'/project'}, signal)).rejects.toThrow()
  expect(rpc).toHaveBeenCalledTimes(2)
})

it('restores each confirmed queued input before interrupt and sends once after the stop receipt', async () => {
  const target = {sessionId:'s',branchId:'b'}
  const signal = new AbortController().signal
  const nextId = () => crypto.randomUUID()
  for (const failure of ['none','consumed','unknown','nonText','stop'] as const) {
    const saves: string[] = []
    const rpc = vi.fn(async (method: string, raw: unknown) => {
      const input = raw as {inputId?:string;operationId?:string;requestId?:string;text?:string}
      if (method === 'dima.app.inbox') return { ...target, actions:['retrieve'], questions:[], queue:['a','b'].map(inputId=>({inputId,mode:'queue',editable:failure !== 'nonText',text:inputId})) }
      if (method === 'dima.app.act') {
        if (input.inputId === 'b' && failure === 'unknown') throw Error('lost receipt')
        if (input.inputId === 'b' && failure === 'consumed') throw Object.assign(Error('consumed'),{code:'DIMA_INPUT_NOT_HELD'})
        return {...target,kind:'retrieve',operationId:input.operationId,restoredText:input.inputId}
      }
      if (method === 'dima.app.interrupt') { if (failure==='stop') throw Error('lost stop'); return target }
      if (method === 'dima.app.submit') { expect(input.text).toBe(failure === 'consumed' ? 'a\ndraft' : 'a\nb\ndraft'); return {...target,requestId:input.requestId} }
      throw Error(method)
    })
    const result=stopWithDimaDraft(createDimaClient(rpc,()=>true,()=>true),target,'draft',true,signal,nextId,value=>saves.push(value))
    if (failure === 'none' || failure === 'consumed') { await result; expect(saves.at(-1)).toBe(''); expect(rpc.mock.calls.filter(c=>c[0]==='dima.app.submit')).toHaveLength(1) }
    else { await expect(result).rejects.toThrow(); expect(rpc.mock.calls.some(c=>c[0]==='dima.app.submit')).toBe(false) }
    if (failure==='unknown') expect(saves).toEqual(['a\ndraft'])
    if (failure==='stop') expect(saves).toEqual(['a\ndraft','a\nb\ndraft'])
    if (failure==='nonText') expect(rpc).toHaveBeenCalledTimes(1)
  }
})

it('reads only the selected native session and branch and surfaces Host errors', async () => {
  const signal = new AbortController().signal
  const request = { sessionId: 'native-session', branchId: 'native-branch' }
  const catalog = { workspaces: [{ cwd: '/project', sessions: [{ sessionId: request.sessionId, title: 'Project', branches: [request.branchId] }] }] }
  const history = { ...request, messages: [{ role: 'user', text: 'Message' }], truncated: true }
  const rpc = vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce(history)
  const reader = createDimaClient(rpc, interactive => !interactive)
  await expect(reader.catalog(signal)).resolves.toEqual(catalog)
  await expect(reader.history(request, signal)).resolves.toEqual(history)
  expect(rpc.mock.calls).toEqual([['dima.app.catalog', {}, signal], ['dima.app.history', request, signal]])

  for (const reply of [{ ...history, sessionId: 'other' }, { ...history, branchId: 'other' }, {}]) {
    rpc.mockResolvedValueOnce(reply)
    await expect(reader.history(request, signal)).rejects.toThrow()
  }
  const failure = Object.assign(new Error('unavailable'), { code: 'DIMA_UNAVAILABLE' })
  rpc.mockRejectedValueOnce(failure)
  await expect(reader.catalog(signal)).rejects.toBe(failure)
})

const branch = { sessionId: 'session', branchId: 'topic' }
const create = { cwd: '/project', requestId: '16e224fe-2d16-4402-821d-08a8a4766f72' }
const submit = { ...branch, requestId: '304f5798-4bdc-4201-9842-3e65d56e35be', text: '  Hello\n' }
const approval = { requestId: 'native-approval', tool: 'read', reason: 'Look up the file', input: '{"path":"example"}' }
const status = { ...branch, running: true, stopping: false, approvals: [approval] }
const respond = { ...branch, requestId: approval.requestId, decision: 'allow' as const }

it('correlates workspace, branch and native approval receipts with the dispatched operation', async () => {
  const signal = new AbortController().signal
  const rpc = vi.fn()
  const client = createDimaClient(rpc, () => true)
  const history = { ...branch, messages: [], truncated: true, lastTurnIssue: { status: 'failed', detail: 'Model unavailable' } }
  const cases = [
    { method: 'history', params: { ...branch, window: 'recent' }, invoke: () => client.history({ ...branch, window: 'recent' }, signal), reply: history, wrong: { ...history, branchId: 'other' } },
    { method: 'create', params: create, invoke: () => client.create(create, signal), reply: { ...branch, cwd: create.cwd }, wrong: { ...branch, cwd: '/other' } },
    { method: 'submit', params: submit, invoke: () => client.submit(submit, signal), reply: { ...branch, requestId: submit.requestId }, wrong: { ...branch, requestId: create.requestId } },
    { method: 'status', params: branch, invoke: () => client.status(branch, signal), reply: status, wrong: { ...status, sessionId: 'other' } },
    { method: 'respond', params: respond, invoke: () => client.respond(respond, signal), reply: { ...branch, requestId: respond.requestId }, wrong: { ...branch, requestId: 'another-request' } },
    { method: 'interrupt', params: branch, invoke: () => client.interrupt(branch, signal), reply: branch, wrong: { ...branch, branchId: 'other' } },
  ]
  for (const { method, params, invoke, reply, wrong } of cases) {
    rpc.mockClear().mockResolvedValueOnce(reply).mockResolvedValueOnce(wrong)
    await expect(invoke(), method).resolves.toEqual(reply)
    await expect(invoke(), method).rejects.toThrow()
    expect(rpc.mock.calls, method).toEqual(Array(2).fill(['dima.app.' + method, params, signal]))
  }
})

it('preserves read-only Hosts and never retries a mutation after a lost reply or a retired branch', async () => {
  const controller = new AbortController()
  const { signal } = controller
  let writable = false
  let current = true
  const rpc = vi.fn().mockResolvedValueOnce({ workspaces: [] })
  const client = createDimaClient(rpc, interactive => current && (!interactive || writable))
  await expect(client.catalog(signal)).resolves.toEqual({ workspaces: [] })
  for (const run of [() => client.history({ ...branch, window: 'recent' }, signal), () => client.create(create, signal), () => client.submit(submit, signal), () => client.status(branch, signal),
    () => client.respond(respond, signal), () => client.interrupt(branch, signal)]) {
    await expect(run()).rejects.toThrow()
  }
  expect(rpc).toHaveBeenCalledTimes(1)
  rpc.mockClear()
  writable = true
  const lostReply = new Error('disconnected')
  rpc.mockRejectedValueOnce(lostReply)
  await expect(client.submit(submit, signal)).rejects.toBe(lostReply)
  expect(rpc).toHaveBeenCalledTimes(1)

  rpc.mockImplementationOnce(async () => { current = false; return { ...branch, cwd: create.cwd } })
  await expect(client.create(create, signal)).rejects.toThrow()
  await expect(client.interrupt(branch, signal)).rejects.toThrow()
  expect(rpc).toHaveBeenCalledTimes(2)

  current = true
  rpc.mockImplementationOnce(async () => { controller.abort(); return { ...branch, requestId: respond.requestId } })
  await expect(client.respond(respond, signal)).rejects.toThrow()
  await expect(client.respond(respond, signal)).rejects.toThrow()
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(['dima.app.submit', 'dima.app.create', 'dima.app.respond'])
})
