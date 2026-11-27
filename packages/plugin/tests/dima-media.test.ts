import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import {
  DIMA_IMAGE_MAX_BYTES,
  DIMA_MEDIA_CHUNK_BYTES,
  DIMA_PASTE_MAX_BYTES,
  DIMA_MEDIA_READ_BYTES,
  readDimaImage,
  type DimaImageReference,
  isDimaImageReference,
  dimaMediaSubmitRequestSchema,
  dimaMediaUploadRequestSchema,
  prepareDimaUpload,
  renewDimaMediaUploads,
  type DimaDraftUpload,
  type DimaMediaUploadRequest,
} from '@dsh-remote/protocol'
import { DimaMedia, mediaNativeMethods } from '../src/dima/media.js'
import type { NativeRpc } from '../src/dima/native-rpc.js'

const dir = await mkdtemp(path.join(tmpdir(), 'dima-media-test-'))
const target = { sessionId: 'session', branchId: 'child' }
const scope = { owner: 'device-A', instanceId: 'daemon-A', cwd: dir }
const filePath = path.join(dir, 'file.md')
await writeFile(filePath, 'test')
const media = new DimaMedia()
afterEach(() => media.clear())
afterAll(() => rm(dir, { recursive: true, force: true }))

function engine(custom?: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: string[] = []
  const rpc = {
    requestFrameBytes(method: string, params: Record<string, unknown>) {
      return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: calls.length + 1, method, params }))
    },
    async call(method: string, p: Record<string, unknown>) {
      calls.push(method)
      const answer = custom?.(method, p)
      if (answer !== undefined) return answer
      switch (method) {
        case 'session.methods':
          return {
            methods: mediaNativeMethods.map((name) => ({
              name,
              mutating: name === 'attachment.put' || name === 'attachment.import',
            })),
          }
        case 'session.files.search':
          return { candidates: [{ absolutePath: filePath, relativePath: 'file.md', dir: false }] }
        case 'attachment.put':
          return { attachmentId: 'owned-text', path: path.join(dir, 'owned'), bytes: Buffer.byteLength(String(p.text)) }
        case 'session.input_lookup':
          return { status: 'unknown' }
        case 'session.submit':
          return {
            event: { type: 'input', name: 'message', data: { submission_id: p.submissionId, mode: p.mode, user: p.user } },
          }
        default:
          throw new Error(method)
      }
    },
  } as unknown as NativeRpc
  return { rpc, calls }
}
it('rechecks committed user file identity before reading an image chunk, including the header for nonzero offsets', async () => {
  const ref: DimaImageReference = { ...target, fileId: randomUUID(), sequence: 7, mediaType: 'image/png' }
  const source = { type: 'file', fileId: ref.fileId, mediaType: ref.mediaType }
  const input = {
    id: 'committed-event',
    sequence: 7,
    type: 'input',
    name: 'message',
    data: { user: { content: [{ type: 'image', source }] } },
  }
  let event: unknown = input
  let bytes = Buffer.from('89504e470d0a1a0a', 'hex')
  const offsets: number[] = []
  const { rpc } = engine((m, p) => {
    if (m === 'session.history')
      return 'before' in p ? { through: 9, nextBefore: 4, nextAfter: 4 } : { through: 9, events: [event] }
    if (m === 'attachment.read') {
      offsets.push(Number(p.offset))
      const part = bytes.subarray(Number(p.offset))
      return { data: part.toString('base64'), eof: !part.length }
    }
  })
  expect(await media.mediaRead(rpc, { ...ref, offset: 8 })).toEqual({ ...ref, offset: 8, data: '', eof: true })
  expect(offsets).toEqual([0, 8])
  offsets.length = 0
  for (const row of [
    { ...input, type: 'step' },
    { ...input, parent_call_id: 'subagent' },
    { ...input, sequence: 8 },
    { ...input, data: { user: { content: [{ type: 'image', source: { ...source, type: 'url' } }] } } },
  ]) {
    event = row
    await expect(media.mediaRead(rpc, { ...ref, offset: 0 })).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  }
  expect(offsets).toEqual([])
  event = input
  bytes = Buffer.from('<html>')
  await expect(media.mediaRead(rpc, { ...ref, offset: 1 })).rejects.toMatchObject({ code: 'DIMA_PROTOCOL_ERROR' })
  expect(offsets).toEqual([0])
})

it('bounds and validates image fragments and stops reading after cancellation', async () => {
  const ref: DimaImageReference = { ...target, fileId: randomUUID(), sequence: 1, mediaType: 'image/gif' }
  const signal = new AbortController().signal
  const data = Buffer.from('GIF89a1234').toString('base64')
  expect(isDimaImageReference({ ...ref, fileId: 'image.png' })).toBe(false)
  expect(isDimaImageReference({ ...ref, mediaType: 'image/svg+xml' })).toBe(false)
  expect(await readDimaImage(ref, async (p) => ({ ...p, data: p.offset ? '' : data, eof: !!p.offset }), signal)).toEqual({
    bytes: Uint8Array.from(Buffer.from(data, 'base64')),
    mediaType: 'image/gif',
  })
  for (const mutation of [
    { fileId: randomUUID() },
    { sequence: 2 },
    { branchId: 'another' },
    { offset: 4 },
    { data: 'AAAA' },
    { data: 'R0lGODlh!!' },
    { data: 'a'.repeat(4 * Math.ceil(DIMA_MEDIA_READ_BYTES / 3) + 4) },
    { eof: true },
  ]) {
    await expect(readDimaImage(ref, async (p) => ({ ...p, data, eof: false, ...mutation }), signal)).rejects.toThrow()
  }
  let calls = 0
  const controller = new AbortController()
  await expect(
    readDimaImage(
      ref,
      async (p) => {
        calls++
        controller.abort()
        return { ...p, data, eof: false }
      },
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(calls).toBe(1)
  await expect(
    readDimaImage(
      ref,
      async () => {
        calls++
        throw Error()
      },
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(calls).toBe(1)
})

it('accepts exactly 16 MiB over bounded read replies and rejects one additional byte before allocating the result', async () => {
  const ref: DimaImageReference = { ...target, fileId: randomUUID(), sequence: 1, mediaType: 'image/png' }
  const block = Buffer.alloc(DIMA_MEDIA_READ_BYTES)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(block)
  const data = block.toString('base64')
  const load = (overflow: boolean) =>
    readDimaImage(
      ref,
      async (p) => {
        const end = p.offset === DIMA_IMAGE_MAX_BYTES
        return { ...p, data: end ? (overflow ? 'YQ==' : '') : data, eof: end && !overflow }
      },
      new AbortController().signal,
    )
  expect((await load(false)).bytes.byteLength).toBe(DIMA_IMAGE_MAX_BYTES)
  await expect(load(true)).rejects.toThrow()
})

function chunk(bytes: Buffer, id: string, offset = 0, kind: 'paste' | 'image' = 'paste'): DimaMediaUploadRequest {
  return {
    ...target,
    uploadId: id,
    kind,
    offset,
    totalBytes: bytes.length,
    data: bytes.subarray(offset, offset + DIMA_MEDIA_CHUNK_BYTES).toString('base64'),
  }
}

it('coalesces concurrent final chunks, rejects byte conflicts and binds uploaded references to owner, daemon and branch', async () => {
  const { rpc, calls } = engine()
  const id = randomUUID(),
    p = chunk(Buffer.from('例\r\n'), id)
  const [a, b] = await Promise.all([media.mediaUpload(rpc, p, scope), media.mediaUpload(rpc, p, scope)])
  expect(a).toEqual(b)
  expect(calls.filter((m) => m === 'attachment.put')).toHaveLength(1)
  await expect(media.mediaUpload(rpc, chunk(Buffer.from('样\r\n'), id), scope)).rejects.toMatchObject({
    code: 'DIMA_REQUEST_CONFLICT',
  })
  const request = {
    ...target,
    mode: 'queue' as const,
    requestId: randomUUID(),
    parts: [{ type: 'upload' as const, uploadId: id }],
  }
  for (const other of [
    { ...scope, owner: 'B' },
    { ...scope, instanceId: 'B' },
  ]) {
    await expect(media.mediaSubmit(rpc, request, other)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  }
  await expect(
    media.mediaSubmit(rpc, { ...request, branchId: 'other', requestId: randomUUID() }, scope),
  ).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  expect((await media.mediaSubmit(rpc, request, scope)).requestId).toBe(request.requestId)
  await media.mediaSubmit(rpc, request, scope)
  expect(calls.filter((m) => m === 'session.submit')).toHaveLength(1)
})

it('accepts ordered canonical chunks and refuses malformed base64, out-of-order offsets and oversized wire requests', async () => {
  const { rpc, calls } = engine(),
    id = randomUUID()
  const bytes = Buffer.alloc(DIMA_MEDIA_CHUNK_BYTES + 1, 120)
  const first = chunk(bytes, id),
    final = chunk(bytes, id, DIMA_MEDIA_CHUNK_BYTES)
  await expect(media.mediaUpload(rpc, final, scope)).rejects.toMatchObject({ code: 'DIMA_REQUEST_CONFLICT' })
  await expect(media.mediaUpload(rpc, { ...first, data: '!'.repeat(first.data.length) }, scope)).rejects.toMatchObject({
    code: 'INVALID_PARAMS',
  })
  await expect(media.mediaUpload(rpc, first, scope)).resolves.toMatchObject({ complete: false })
  await expect(media.mediaUpload(rpc, first, scope)).resolves.toMatchObject({ complete: false })
  await expect(media.mediaUpload(rpc, final, scope)).resolves.toMatchObject({ complete: true })
  for (const [kind, size] of [
    ['image', DIMA_IMAGE_MAX_BYTES],
    ['paste', DIMA_PASTE_MAX_BYTES],
  ] as const) {
    expect(dimaMediaUploadRequestSchema.safeParse({ ...first, kind, totalBytes: size }).success).toBe(true)
    expect(dimaMediaUploadRequestSchema.safeParse({ ...first, kind, totalBytes: size + 1 }).success).toBe(false)
  }
  expect(dimaMediaUploadRequestSchema.safeParse({ ...first, offset: 1 }).success).toBe(false)
  expect(dimaMediaUploadRequestSchema.safeParse({ ...first, path: 'arbitrary' }).success).toBe(false)
  expect(
    dimaMediaSubmitRequestSchema.safeParse({
      ...target,
      requestId: id,
      mode: 'queue',
      parts: [
        { type: 'text', text: 'x'.repeat(65536) },
        { type: 'text', text: 'x' },
      ],
    }).success,
  ).toBe(false)
  await expect(media.mediaUpload(rpc, chunk(Buffer.from([0xc3, 0x28]), randomUUID()), scope)).rejects.toMatchObject({
    code: 'INVALID_PARAMS',
  })
  expect(calls.filter((m) => m === 'attachment.put')).toHaveLength(1)
})

it('retains an unknown import receipt and removes the private staging file without accepting caller-provided paths', async () => {
  let scratch = ''
  const { rpc, calls } = engine(asyncAnswer)
  function asyncAnswer(method: string, p: Record<string, unknown>) {
    if (method === 'attachment.import')
      return (async () => {
        scratch = String(p.path)
        expect(path.dirname(scratch)).not.toBe(dir)
        expect(await readFile(scratch)).toEqual(Buffer.from('image fixture'))
        throw new Error('transport lost after mutation')
      })()
  }
  const p = chunk(Buffer.from('image fixture'), randomUUID(), 0, 'image')
  for (let n = 0; n < 2; n++)
    await expect(media.mediaUpload(rpc, p, scope)).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
  expect(calls.filter((m) => m === 'attachment.import')).toHaveLength(1)
  await expect(readFile(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('validates native relative candidates and resolves only current workspace choices at submit', async () => {
  const { rpc, calls } = engine()
  expect((await media.mediaSearch(rpc, { ...target, query: 'file' }, scope)).files).toEqual(['file.md'])
  for (const q of ['../x', 'C:/x', '/outside', '~/x'])
    expect((await media.mediaSearch(rpc, { ...target, query: q }, scope)).files).toEqual([])
  expect(calls.filter((m) => m === 'session.files.search')).toHaveLength(1)
  const bad = engine((m) =>
    m === 'session.files.search'
      ? { candidates: [{ relativePath: 'x', absolutePath: path.join(tmpdir(), 'outside'), dir: false }] }
      : undefined,
  )
  await expect(media.mediaSearch(bad.rpc, { ...target, query: 'x' }, scope)).rejects.toMatchObject({
    code: 'DIMA_PROTOCOL_ERROR',
  })
  const req = {
    ...target,
    requestId: randomUUID(),
    mode: 'steer' as const,
    parts: [{ type: 'file' as const, path: 'never-indexed.md' }],
  }
  await expect(media.mediaSubmit(rpc, req, scope)).rejects.toMatchObject({ code: 'DIMA_NOT_FOUND' })
  expect(calls).not.toContain('session.submit')
  const missing = engine((m) => (m === 'session.methods' ? { methods: [] } : undefined))
  await expect(media.mediaSearch(missing.rpc, { ...target, query: 'file' }, scope)).rejects.toMatchObject({
    code: 'DIMA_INCOMPATIBLE',
  })
})

it('restores an accepted media receipt and rejects a conflicting submission UUID without resending', async () => {
  const requestId = randomUUID()
  const accepted = engine((m) =>
    m === 'session.input_lookup'
      ? {
          status: 'accepted',
          event: {
            type: 'input',
            name: 'message',
            data: { submission_id: requestId, mode: 'steer', user: { content: [{ type: 'text', text: filePath }] } },
          },
        }
      : undefined,
  )
  const req = { ...target, mode: 'steer' as const, requestId, parts: [{ type: 'file' as const, path: 'file.md' }] }
  expect((await media.mediaSubmit(accepted.rpc, req, scope)).requestId).toBe(requestId)
  await expect(media.mediaSubmit(accepted.rpc, { ...req, mode: 'queue' }, scope)).rejects.toMatchObject({
    code: 'DIMA_REQUEST_CONFLICT',
  })
  expect(accepted.calls).not.toContain('session.submit')
})

it('enforces the native ceiling of 20 images even when the caller duplicates a confirmed handle', async () => {
  const { rpc, calls } = engine((m) =>
    m === 'attachment.import'
      ? { attachmentId: 'img', bytes: 1, image: { type: 'file', mediaType: 'image/png', fileId: 'img' } }
      : undefined,
  )
  const uploadId = randomUUID()
  await media.mediaUpload(rpc, chunk(Buffer.from('fixture'), uploadId, 0, 'image'), scope)
  const part = { type: 'upload' as const, uploadId }
  await expect(
    media.mediaSubmit(rpc, { ...target, requestId: randomUUID(), mode: 'queue', parts: Array(21).fill(part) }, scope),
  ).rejects.toMatchObject({ code: 'DIMA_LIMIT_EXCEEDED' })
  expect(calls).not.toContain('session.submit')
  await media.mediaSubmit(rpc, { ...target, requestId: randomUUID(), mode: 'queue', parts: Array(20).fill(part) }, scope)
  expect(calls.filter((m) => m === 'session.submit')).toHaveLength(1)
})

it('keeps local selections across reconnection and discards stale offsets without reading or sending', async () => {
  let reads = 0
  const file = { label: '@file.md', path: 'file.md' }
  const image = {
    label: 'img',
    upload: {
      kind: 'image' as const,
      uploadId: randomUUID(),
      totalBytes: 1,
      nextOffset: 1,
      readBase64: async () => {
        reads++
        return 'eA=='
      },
    },
  }
  const [retained, renewed] = renewDimaMediaUploads([file, image], randomUUID)
  expect(retained).toBe(file)
  if (!renewed || !('upload' in renewed)) throw new Error('Missing retained image')
  expect(renewed.upload.uploadId).not.toBe(image.upload.uploadId)
  expect(renewed.upload.nextOffset).toBe(0)
  expect(renewed.upload.readBase64).toBe(image.upload.readBase64)
  image.upload.nextOffset = 1
  expect(renewed.upload.nextOffset).toBe(0)
  expect(reads).toBe(0)
})

it('keeps only confirmed ranges in a local draft and catches late receipts for another branch', async () => {
  const bytes = Buffer.alloc(DIMA_MEDIA_CHUNK_BYTES + 20, 1)
  const item: DimaDraftUpload = {
    kind: 'paste',
    uploadId: randomUUID(),
    totalBytes: bytes.length,
    nextOffset: 0,
    readBase64: async (offset, length) => bytes.subarray(offset, offset + length).toString('base64'),
  }
  const { rpc } = engine()
  await expect(
    prepareDimaUpload(item, target, async (p) => {
      const receipt = await media.mediaUpload(rpc, p, scope)
      return p.offset ? { ...receipt, branchId: 'another' } : receipt
    }),
  ).rejects.toThrow('receipt')
  expect(item.nextOffset).toBe(DIMA_MEDIA_CHUNK_BYTES)
  expect(await prepareDimaUpload(item, target, (p) => media.mediaUpload(rpc, p, scope))).toEqual({
    type: 'upload',
    uploadId: item.uploadId,
  })
})
