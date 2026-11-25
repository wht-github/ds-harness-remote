import { expect, it, vi } from 'vitest'
import { createDimaReader } from '../src/services/dima'

it('reads only the selected native session and branch and surfaces Host errors', async () => {
  const signal = new AbortController().signal
  const request = { sessionId: 'native-session', branchId: 'native-branch' }
  const catalog = { workspaces: [{ cwd: '/project', sessions: [{ sessionId: request.sessionId, title: 'Project', branches: [request.branchId] }] }] }
  const history = { ...request, messages: [{ role: 'user', text: 'Message' }], truncated: true }
  const rpc = vi.fn().mockResolvedValueOnce(catalog).mockResolvedValueOnce(history)
  const reader = createDimaReader(rpc)
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
