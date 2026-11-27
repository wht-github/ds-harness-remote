import { z } from 'zod'
import { DIMA_MAX_PROMPT_CHARS, dimaHistoryRequestSchema, dimaSubmitResultSchema } from './dima.js'

export const DIMA_MEDIA_CHUNK_BYTES = 192 * 1024
export const DIMA_IMAGE_MAX_BYTES = 16 * 1024 * 1024
export const DIMA_PASTE_MAX_BYTES = 10 * 1024 * 1024
export const DIMA_MEDIA_MAX_IMAGES = 20
export const DIMA_MEDIA_MAX_PARTS = 32
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
const uploadId = z.uuid()
const reference = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload'), uploadId }).strict(),
  z.object({ type: z.literal('file'), path: filePath }).strict(),
])
export type DimaMediaReference = z.infer<typeof reference>
export const dimaMediaUploadRequestSchema = dimaHistoryRequestSchema
  .extend({
    uploadId,
    kind: z.enum(['image', 'paste']),
    offset: z
      .int()
      .min(0)
      .max(DIMA_IMAGE_MAX_BYTES - 1),
    totalBytes: z.int().min(1).max(DIMA_IMAGE_MAX_BYTES),
    data: z
      .string()
      .min(4)
      .max((DIMA_MEDIA_CHUNK_BYTES / 3) * 4),
  })
  .superRefine((p, context) => {
    const length = Math.min(DIMA_MEDIA_CHUNK_BYTES, p.totalBytes - p.offset)
    if (
      p.offset % DIMA_MEDIA_CHUNK_BYTES !== 0 ||
      length <= 0 ||
      p.data.length !== 4 * Math.ceil(length / 3) ||
      (p.kind === 'paste' && p.totalBytes > DIMA_PASTE_MAX_BYTES)
    )
      context.addIssue({ code: 'custom', message: 'Invalid DimAgent attachment range.' })
  })
export const dimaMediaUploadResultSchema = dimaHistoryRequestSchema.extend({
  uploadId,
  nextOffset: z.int().positive().max(DIMA_IMAGE_MAX_BYTES),
  complete: z.boolean(),
})
export const dimaMediaSearchRequestSchema = dimaHistoryRequestSchema.extend({
  query: z
    .string()
    .max(4096)
    .refine((q) => !q.includes('\0')),
})
export const dimaMediaSearchResultSchema = dimaHistoryRequestSchema.extend({ files: z.array(filePath).max(20) })
export const dimaMediaSubmitRequestSchema = dimaSubmitResultSchema
  .extend({
    mode: z.enum(['queue', 'steer']),
    parts: z
      .array(
        z.union([
          reference,
          z.object({ type: z.literal('text'), text: z.string().min(1).max(DIMA_MAX_PROMPT_CHARS) }).strict(),
        ]),
      )
      .min(1)
      .max(DIMA_MEDIA_MAX_PARTS),
  })
  .refine(
    (p) =>
      p.parts.some((part) => part.type !== 'text' || part.text.trim().length > 0) &&
      p.parts.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0) <= DIMA_MAX_PROMPT_CHARS,
  )
export const DIMA_MEDIA_READ_BYTES = 64 * 1024
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type DimaImageMediaType = (typeof imageTypes)[number]
export function isDimaImageMediaType(value: string): value is DimaImageMediaType {
  return imageTypes.some((type) => value === type)
}
const imageReference = dimaHistoryRequestSchema.extend({
  sequence: z.int().positive(),
  fileId: z.uuid(),
  mediaType: z.enum(imageTypes),
})
export type DimaImageReference = z.infer<typeof imageReference>
export function isDimaImageReference(value: unknown): value is DimaImageReference {
  return imageReference.safeParse(value).success
}
export const dimaMediaReadRequestSchema = imageReference.extend({ offset: z.int().min(0).max(DIMA_IMAGE_MAX_BYTES) })
export const dimaMediaReadResultSchema = dimaMediaReadRequestSchema
  .extend({ data: z.string().max(4 * Math.ceil(DIMA_MEDIA_READ_BYTES / 3)), eof: z.boolean() })
  .refine((p) => (p.data === '') === p.eof)
export function matchesDimaImageType(bytes: Uint8Array, type: DimaImageMediaType): boolean {
  const starts = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value)
  switch (type) {
    case 'image/png':
      return starts([137, 80, 78, 71, 13, 10, 26, 10])
    case 'image/jpeg':
      return starts([255, 216, 255])
    case 'image/gif':
      return starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])
    case 'image/webp':
      return starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)
  }
}
export type DimaMediaReadRequest = z.infer<typeof dimaMediaReadRequestSchema>
export type DimaMediaReadResult = z.infer<typeof dimaMediaReadResultSchema>

/** Read an explicitly selected committed user image. Offsets count decoded bytes;
 * native EOF is an empty final reply after the last nonempty chunk. */
export async function readDimaImage(
  reference: DimaImageReference,
  read: (request: DimaMediaReadRequest) => Promise<DimaMediaReadResult>,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: DimaImageMediaType }> {
  const target = imageReference.parse(reference)
  const chunks: Uint8Array[] = []
  let offset = 0
  const checkActive = () => {
    if (signal.aborted) throw new Error('DimAgent image preview cancelled.')
  }
  const invalid = () => new Error('DimAgent returned an invalid image preview.')
  for (let requests = 0; requests <= Math.ceil(DIMA_IMAGE_MAX_BYTES / DIMA_MEDIA_READ_BYTES); requests++) {
    checkActive()
    const result = dimaMediaReadResultSchema.parse(await read({ ...target, offset }))
    checkActive()
    if (
      result.sessionId !== target.sessionId ||
      result.branchId !== target.branchId ||
      result.sequence !== target.sequence ||
      result.fileId !== target.fileId ||
      result.mediaType !== target.mediaType ||
      result.offset !== offset
    )
      throw invalid()
    if (result.eof) {
      if (!offset) throw invalid()
      const bytes = new Uint8Array(offset)
      let at = 0
      for (const part of chunks) {
        bytes.set(part, at)
        at += part.length
      }
      if (!matchesDimaImageType(bytes, target.mediaType)) throw invalid()
      return { bytes, mediaType: target.mediaType }
    }
    const raw = atob(result.data)
    if (
      !raw.length ||
      raw.length > DIMA_MEDIA_READ_BYTES ||
      raw.length + offset > DIMA_IMAGE_MAX_BYTES ||
      btoa(raw) !== result.data
    )
      throw invalid()
    const part = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) part[i] = raw.charCodeAt(i)
    if (!offset && !matchesDimaImageType(part, target.mediaType)) throw invalid()
    chunks.push(part)
    offset += part.length
  }
  throw invalid()
}
export const dimaMediaOperations = {
  mediaRead: { request: dimaMediaReadRequestSchema, result: dimaMediaReadResultSchema },
  mediaUpload: { request: dimaMediaUploadRequestSchema, result: dimaMediaUploadResultSchema },
  mediaSearch: { request: dimaMediaSearchRequestSchema, result: dimaMediaSearchResultSchema },
  mediaSubmit: { request: dimaMediaSubmitRequestSchema, result: dimaSubmitResultSchema },
} as const
export type DimaMediaUploadRequest = z.infer<typeof dimaMediaUploadRequestSchema>
export type DimaMediaUploadResult = z.infer<typeof dimaMediaUploadResultSchema>
export type DimaMediaSearchRequest = z.infer<typeof dimaMediaSearchRequestSchema>
export type DimaMediaSearchResult = z.infer<typeof dimaMediaSearchResultSchema>
export type DimaMediaSubmitRequest = z.infer<typeof dimaMediaSubmitRequestSchema>

/** Local staged bytes are read only when the operator submits. Both clients retain the
 * last confirmed offset so a later explicit action can reuse identical chunks and ids. */
export interface DimaDraftUpload {
  kind: 'image' | 'paste'
  uploadId: string
  totalBytes: number
  nextOffset: number
  readBase64(offset: number, length: number): Promise<string>
}
export type DimaDraftMediaItem = { label: string; upload: DimaDraftUpload } | { label: string; path: string }

/** Rebind only the local source selection after a connection change. Pending work on
 * an older connection cannot alter the new handles. Reading bytes requires an explicit send. */
export function renewDimaMediaUploads(items: readonly DimaDraftMediaItem[], uuid: () => string): DimaDraftMediaItem[] {
  return items.map((item) =>
    'path' in item ? item : { ...item, upload: { ...item.upload, uploadId: uuid(), nextOffset: 0 } },
  )
}

export async function prepareDimaUpload(
  item: DimaDraftUpload,
  target: { sessionId: string; branchId: string },
  send: (request: DimaMediaUploadRequest) => Promise<DimaMediaUploadResult>,
): Promise<DimaMediaReference> {
  if (
    !Number.isSafeInteger(item.totalBytes) ||
    item.totalBytes < 1 ||
    item.totalBytes > (item.kind === 'paste' ? DIMA_PASTE_MAX_BYTES : DIMA_IMAGE_MAX_BYTES)
  ) {
    throw new RangeError('DimAgent attachment size is outside the supported range.')
  }
  if (
    !Number.isSafeInteger(item.nextOffset) ||
    item.nextOffset < 0 ||
    item.nextOffset > item.totalBytes ||
    (item.nextOffset !== item.totalBytes && item.nextOffset % DIMA_MEDIA_CHUNK_BYTES !== 0)
  )
    throw new RangeError('Invalid DimAgent attachment offset.')
  while (item.nextOffset < item.totalBytes) {
    const offset = item.nextOffset
    const length = Math.min(DIMA_MEDIA_CHUNK_BYTES, item.totalBytes - offset)
    const data = await item.readBase64(offset, length)
    const receipt = await send({
      sessionId: target.sessionId,
      branchId: target.branchId,
      kind: item.kind,
      uploadId: item.uploadId,
      offset,
      totalBytes: item.totalBytes,
      data,
    })
    if (
      receipt.sessionId !== target.sessionId ||
      receipt.branchId !== target.branchId ||
      receipt.uploadId !== item.uploadId ||
      receipt.nextOffset !== offset + length ||
      receipt.complete !== (receipt.nextOffset === item.totalBytes)
    )
      throw new Error('Invalid DimAgent attachment receipt.')
    item.nextOffset = receipt.nextOffset
  }
  return { type: 'upload', uploadId: item.uploadId }
}
