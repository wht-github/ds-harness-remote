import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  DIMA_IMAGE_MAX_BYTES,
  DIMA_MEDIA_READ_BYTES,
  DIMA_MEDIA_MAX_IMAGES,
  dimaMediaReadRequestSchema,
  matchesDimaImageType,
  type DimaMediaReadRequest,
  dimaMediaSearchRequestSchema,
  dimaMediaSubmitRequestSchema,
  dimaMediaUploadRequestSchema,
  type DimaMediaSearchRequest,
  type DimaMediaSubmitRequest,
  type DimaMediaUploadRequest,
  type DimaSubmitResult,
} from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { mutation, notFound, Receipts } from './interaction.js'
import { MediaUploads, requireMediaMethod, type MediaBlock, type MediaContext } from './media-upload.js'
import { invalidReply, record, tooLarge, type NativeRpc } from './native-rpc.js'
import { projectTimeline } from './timeline-projection.js'

export const mediaNativeMethods = [
  'session.methods',
  'session.files.search',
  'attachment.put',
  'attachment.import',
  'attachment.read',
  'session.input_lookup',
  'session.submit',
] as const

function withinQuery(q: string) {
  return (
    !/[\u0000-\u001f\u007f]/.test(q) &&
    !q.startsWith('~') &&
    !path.isAbsolute(q) &&
    !path.win32.isAbsolute(q) &&
    !/^[A-Za-z]:/.test(q) &&
    !q.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..')
  )
}

/** Only native-indexed regular files under the selected Session cwd are selectable.
 * No contents are read here. The native model receives the chosen path as a text block. */
async function candidates(rpc: NativeRpc, sessionId: string, cwd: string, query: string) {
  const found = new Map<string, string>()
  if (!withinQuery(query)) return found
  const reply = record(await rpc.call('session.files.search', { sessionId, query, limit: 20 }))
  if (!Array.isArray(reply.candidates) || reply.candidates.length > 20) throw invalidReply()
  const root = await realpath(cwd)
  for (const value of reply.candidates) {
    const row = record(value)
    if (
      typeof row.relativePath !== 'string' ||
      !row.relativePath ||
      typeof row.absolutePath !== 'string' ||
      typeof row.dir !== 'boolean'
    )
      throw invalidReply()
    if (
      row.dir ||
      row.relativePath.length > 4096 ||
      !withinQuery(row.relativePath) ||
      row.relativePath.split('/').some((p) => !p || p === '.')
    )
      continue
    const file = path.resolve(cwd, row.relativePath)
    if (!path.isAbsolute(row.absolutePath) || path.relative(file, row.absolutePath) !== '') throw invalidReply()
    const actual = await realpath(file).catch(() => undefined)
    if (
      !actual ||
      path.relative(path.join(root, row.relativePath), actual) ||
      !(await lstat(file).catch(() => undefined))?.isFile()
    )
      continue
    found.set(row.relativePath, file)
  }
  return found
}

/** Check the selected branch's committed input. Reading the preceding complete batch
 * locates the input even when its sequence is in the middle of an atomic batch. */
async function committedImage(rpc: NativeRpc, p: DimaMediaReadRequest) {
  const target = { sessionId: p.sessionId, branchId: p.branchId }
  const before = record(await rpc.call('session.history', { ...target, before: p.sequence, limit: 1 }))
  if (!Number.isSafeInteger(before.through) || Number(before.through) < p.sequence) throw notFound()
  const after = before.nextBefore == null ? 0 : before.nextAfter
  if (!Number.isSafeInteger(after) || Number(after) < 0 || Number(after) >= p.sequence) throw invalidReply()
  const page = record(await rpc.call('session.history', { ...target, after, through: before.through, limit: 1 }))
  if (page.through !== before.through || !Array.isArray(page.events)) throw invalidReply()
  const event = page.events.find(
    (row) => row?.sequence === p.sequence && row.parent_call_id == null && row.type === 'input' && row.name === 'message',
  )
  if (!event) throw notFound()
  const { turns } = projectTimeline([event], undefined, p.sequence, 0)
  const block = turns[0]?.blocks[0]
  if (
    block?.kind !== 'user' ||
    !block.attachments?.some((file) => file.fileId === p.fileId && file.mediaType === p.mediaType)
  )
    throw notFound()
}

async function nativeImageChunk(rpc: NativeRpc, p: DimaMediaReadRequest, offset: number) {
  const reply = record(await rpc.call('attachment.read', { sessionId: p.sessionId, fileId: p.fileId, offset }))
  if (
    typeof reply.eof !== 'boolean' ||
    typeof reply.data !== 'string' ||
    reply.data.length > 4 * Math.ceil(DIMA_MEDIA_READ_BYTES / 3) ||
    reply.eof !== (reply.data === '')
  )
    throw invalidReply()
  const bytes = Buffer.from(reply.data, 'base64')
  if (bytes.toString('base64') !== reply.data || bytes.length > DIMA_MEDIA_READ_BYTES) throw invalidReply()
  if (offset + bytes.length > DIMA_IMAGE_MAX_BYTES) throw tooLarge()
  if (offset === 0 && !matchesDimaImageType(bytes, p.mediaType)) throw invalidReply()
  return { data: reply.data, eof: reply.eof }
}

/** The caller verifies branch membership and attaches using expectedCwd on this RPC. */
export class DimaMedia {
  private readonly uploads = new MediaUploads()
  private readonly submissions = new Receipts<DimaSubmitResult>()

  async mediaRead(rpc: NativeRpc, input: DimaMediaReadRequest) {
    const p = dimaMediaReadRequestSchema.parse(input)
    await committedImage(rpc, p)
    await requireMediaMethod(rpc, p.sessionId, 'attachment.read', false)
    if (p.offset) await nativeImageChunk(rpc, p, 0)
    return { ...p, ...(await nativeImageChunk(rpc, p, p.offset)) }
  }

  mediaUpload(rpc: NativeRpc, input: DimaMediaUploadRequest, context: MediaContext) {
    return this.uploads.put(rpc, dimaMediaUploadRequestSchema.parse(input), context)
  }

  async mediaSearch(rpc: NativeRpc, input: DimaMediaSearchRequest, context: MediaContext) {
    const { sessionId, branchId, query } = dimaMediaSearchRequestSchema.parse(input)
    await requireMediaMethod(rpc, sessionId, 'session.files.search', false)
    const files = [...(await candidates(rpc, sessionId, context.cwd, query)).keys()]
    return { sessionId, branchId, files }
  }

  async mediaSubmit(rpc: NativeRpc, input: DimaMediaSubmitRequest, context: MediaContext) {
    const params = dimaMediaSubmitRequestSchema.parse(input)
    const { sessionId, branchId, requestId, mode, parts } = params
    const target = { sessionId, branchId }
    return this.submissions.once(JSON.stringify([context.owner, context.instanceId]), requestId, params, async () => {
      const content: MediaBlock[] = []
      if (parts.some((p) => p.type === 'file')) await requireMediaMethod(rpc, sessionId, 'session.files.search', false)
      for (const p of parts) {
        if (p.type === 'text') content.push(p)
        else if (p.type === 'upload') content.push(await this.uploads.resolve(target, context, p.uploadId))
        else {
          const file = (await candidates(rpc, sessionId, context.cwd, p.path)).get(p.path)
          if (!file) throw notFound()
          content.push({ type: 'text', text: file })
        }
      }
      if (content.filter((block) => block.type === 'image').length > DIMA_MEDIA_MAX_IMAGES) {
        throw new RpcError('DIMA_LIMIT_EXCEEDED', 'DimAgent accepts up to 20 images per input.')
      }
      const identity = { ...target, submissionId: requestId }
      const confirm = (receipt: Record<string, unknown>) => {
        const event = record(receipt.event)
        const data = record(event.data)
        if (event.type !== 'input' || event.name !== 'message' || data.submission_id !== requestId) throw invalidReply()
        if (data.mode !== mode || !isDeepStrictEqual(record(data.user).content, content)) {
          throw new RpcError('DIMA_REQUEST_CONFLICT', 'The native input receipt identifies different content.')
        }
        return { ...target, requestId }
      }
      const lookup = record(await rpc.call('session.input_lookup', identity))
      if (lookup.status === 'accepted') return confirm(lookup)
      if (lookup.status !== 'unknown') throw invalidReply()
      return mutation(async () => confirm(record(await rpc.call('session.submit', { ...identity, mode, user: { content } }))))
    })
  }

  clear() {
    this.uploads.clear()
    this.submissions.clear()
  }
}
