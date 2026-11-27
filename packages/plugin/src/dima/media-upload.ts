import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DIMA_MEDIA_CHUNK_BYTES,
  type DimaHistoryRequest,
  type DimaMediaUploadRequest,
  type DimaMediaUploadResult,
} from '@dsh-remote/protocol'
import { RpcError } from '../safe-error.js'
import { limited, mutation, notFound } from './interaction.js'
import { invalidReply, record, tooLarge, type NativeRpc } from './native-rpc.js'

export type MediaContext = { owner: string; instanceId: string; cwd: string }
export type MediaBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'file'; fileId: string; mediaType: string } }
type Upload = {
  kind: 'image' | 'paste'
  total: number
  received: number
  expires: number
  chunks: Buffer[]
  digests: string[]
  stored?: Promise<MediaBlock>
  sealing?: boolean
}
const conflict = () => new RpcError('DIMA_REQUEST_CONFLICT', 'The attachment does not match its upload receipt.')
const invalid = () => new RpcError('INVALID_PARAMS', 'The DimAgent attachment data is invalid.')
const maxStaged = 32 * 1024 * 1024
const nativeFrameLimit = 16 * 1024 * 1024
const keyOf = (target: DimaHistoryRequest, context: MediaContext, id: string) =>
  JSON.stringify([context.owner, context.instanceId, target.sessionId, target.branchId, id])

export async function requireMediaMethod(rpc: NativeRpc, sessionId: string, name: string, mutating: boolean) {
  const { methods } = record(await rpc.call('session.methods', { sessionId }))
  if (!Array.isArray(methods)) throw invalidReply()
  if (!methods.some((m) => m && typeof m === 'object' && m.name === name && m.mutating === mutating)) {
    throw new RpcError('DIMA_INCOMPATIBLE', 'This DimAgent session does not support the requested attachment operation.')
  }
}

async function store(rpc: NativeRpc, sessionId: string, kind: Upload['kind'], bytes: Buffer): Promise<MediaBlock> {
  if (kind === 'paste') {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw invalid()
    }
    const params = { sessionId, text }
    // The native frame limit applies after UTF-8 encoding and JSON escaping, excluding LF.
    if (rpc.requestFrameBytes('attachment.put', params) > nativeFrameLimit) throw tooLarge()
    return mutation(async () => {
      const reply = record(await rpc.call('attachment.put', params))
      if (
        typeof reply.attachmentId !== 'string' ||
        !reply.attachmentId ||
        typeof reply.path !== 'string' ||
        !path.isAbsolute(reply.path) ||
        reply.path.includes('\0') ||
        reply.path.length > 32_768 ||
        reply.bytes !== bytes.length
      )
        throw invalidReply()
      let lines = Number(!text.endsWith('\n'))
      for (let pos = text.indexOf('\n'); pos >= 0; pos = text.indexOf('\n', pos + 1)) lines++
      return { type: 'text', text: '[Pasted text: ' + reply.path + ' (' + lines + ' lines)]' }
    })
  }
  // The only file passed to native import is generated here. Native validates the full
  // image, scales it and commits a session-owned file before this directory is removed.
  const folder = await mkdtemp(path.join(tmpdir(), 'dsh-dima-image-'))
  try {
    const sourcePath = path.join(folder, 'image')
    await writeFile(sourcePath, bytes, { mode: 0o600, flag: 'wx' })
    return await mutation(async () => {
      const reply = record(await rpc.call('attachment.import', { sessionId, path: sourcePath, image: true }))
      const image = record(reply.image)
      if (
        typeof reply.attachmentId !== 'string' ||
        !reply.attachmentId ||
        reply.attachmentId.length > 512 ||
        image.fileId !== reply.attachmentId ||
        image.type !== 'file' ||
        typeof image.mediaType !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType) ||
        typeof reply.bytes !== 'number' ||
        !Number.isSafeInteger(reply.bytes) ||
        reply.bytes <= 0
      )
        throw invalidReply()
      return { type: 'image', source: { type: 'file', fileId: reply.attachmentId, mediaType: image.mediaType } }
    })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Retain only hashes and the native reference after sealing, including a lost final receipt. */
export class MediaUploads {
  private readonly entries = new Map<string, Upload>()
  private generation = 0

  private prune() {
    const now = Date.now()
    for (const [key, entry] of this.entries) if (!entry.sealing && entry.expires <= now) this.entries.delete(key)
  }

  async put(rpc: NativeRpc, p: DimaMediaUploadRequest, context: MediaContext): Promise<DimaMediaUploadResult> {
    const data = Buffer.from(p.data, 'base64')
    if (data.length !== Math.min(DIMA_MEDIA_CHUNK_BYTES, p.totalBytes - p.offset) || data.toString('base64') !== p.data)
      throw invalid()
    const key = keyOf(p, context, p.uploadId)
    const digest = createHash('sha256').update(data).digest('hex')
    this.prune()
    let entry = this.entries.get(key)
    if (!entry) {
      if (p.offset !== 0) throw conflict()
      const generation = this.generation
      await requireMediaMethod(rpc, p.sessionId, p.kind === 'image' ? 'attachment.import' : 'attachment.put', true)
      if (generation !== this.generation) throw notFound()
      entry = this.entries.get(key)
    }
    if (!entry) {
      if (this.entries.size >= 256) throw limited()
      const reserved = [...this.entries.values()].reduce((sum, e) => sum + (!e.stored || e.sealing ? e.total : 0), 0)
      if (reserved + p.totalBytes > maxStaged) throw limited()
      entry = { kind: p.kind, total: p.totalBytes, received: 0, expires: 0, chunks: [], digests: [] }
      this.entries.set(key, entry)
    }
    if (entry.kind !== p.kind || entry.total !== p.totalBytes || p.offset > entry.received) throw conflict()
    const nextOffset = p.offset + data.length
    const complete = nextOffset === p.totalBytes
    if (p.offset < entry.received) {
      if (entry.digests[p.offset / DIMA_MEDIA_CHUNK_BYTES] !== digest) throw conflict()
    } else {
      entry.chunks.push(data)
      entry.digests.push(digest)
      entry.received = nextOffset
      entry.expires = Date.now() + (complete ? 24 * 60 : 15) * 60_000
      if (complete) {
        entry.sealing = true
        const bytes = Buffer.concat(entry.chunks)
        entry.chunks = []
        const sealed = entry
        entry.stored = store(rpc, p.sessionId, p.kind, bytes).finally(() => {
          sealed.sealing = false
        })
      }
    }
    if (complete) await entry.stored
    return { sessionId: p.sessionId, branchId: p.branchId, uploadId: p.uploadId, nextOffset, complete }
  }

  async resolve(target: DimaHistoryRequest, context: MediaContext, uploadId: string) {
    this.prune()
    const stored = this.entries.get(keyOf(target, context, uploadId))?.stored
    if (!stored) throw notFound()
    return stored
  }

  clear() {
    this.generation++
    this.entries.clear()
  }
}
