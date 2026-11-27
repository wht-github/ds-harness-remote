/** Run with vite-node and an absolute official dimcode executable. All writes use a disposable home. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { crc32, deflateSync } from 'node:zlib'
import {
  DIMA_IMAGE_MAX_BYTES,
  DIMA_MEDIA_CHUNK_BYTES,
  DIMA_PASTE_MAX_BYTES,
  readDimaImage,
  type DimaImageReference,
} from '@dsh-remote/protocol'
import { DimaAppServer } from '../../src/dima/app-server.js'
import { DimaMedia } from '../../src/dima/media.js'
import { record, withNativeRpc } from '../../src/dima/native-rpc.js'

const binary = process.argv.at(-1)!
assert(path.isAbsolute(binary) && !binary.endsWith('.ts'))
const home = await mkdtemp(path.join(tmpdir(), 'dsh-dima-media-'))
const nativeHome = path.join(home, 'rust')
const cwd = path.join(home, 'workspace')
await mkdir(nativeHome, { mode: 0o700 })
await mkdir(cwd)
await writeFile(path.join(cwd, 'résumé.md'), 'fixture')
const models = path.join(home, 'models.json')
await writeFile(
  models,
  JSON.stringify({
    defaultModel: { providerId: 'local', modelId: 'small' },
    providers: [
      {
        id: 'local',
        kind: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [{ id: 'small', contextWindow: 8000, maxOutputTokens: 200, config: { maxTokens: 200 } }],
      },
    ],
  }),
)
const key = createHash('sha256')
  .update('dimcode:' + path.toNamespacedPath(await realpath(nativeHome)))
  .digest('hex')
  .slice(0, 32)
const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\dim-rust-` + key : path.join(nativeHome, 'daemon.sock')
const daemon = spawn(
  binary,
  [
    'app-server',
    '--model-config',
    models,
    '--no-ws',
    '--home',
    nativeHome,
    process.platform === 'win32' ? '--pipe' : '--unix',
    endpoint,
  ],
  {
    cwd,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TMP: home,
      TEMP: home,
      TMPDIR: home,
      USERPROFILE: home,
      HOME: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      DIMCODE_HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
)
const exited = once(daemon, 'close')
const startup = createInterface({ input: daemon.stdout })
const deadline = setTimeout(() => daemon.kill(), 90_000)
const media = new DimaMedia()
const host = new DimaAppServer({ home, binary })
try {
  const [line] = await Promise.race([
    once(startup, 'line', { signal: AbortSignal.timeout(15_000) }),
    exited.then((): never => {
      throw new Error('Isolated product daemon exited at startup.')
    }),
  ])
  assert.equal(JSON.parse(line).websocketAddress, null)
  await withNativeRpc({ home, binary }, AbortSignal.timeout(80_000), async (rpc) => {
    const hello = record(await rpc.call('hello', { protocolVersion: 4, clientKind: 'other' }))
    const { sessionId } = record(
      await rpc.call('session.create', { cwd, tools: ['branch'], permissionPolicy: { allowedTools: ['branch'] } }),
    )
    assert(typeof sessionId === 'string' && typeof hello.instanceId === 'string')
    const attached = record(await rpc.call('session.attach', { sessionId, expectedCwd: cwd }))
    const context = { owner: 'fixture', instanceId: hello.instanceId, cwd: String(attached.cwd) }
    const target = { sessionId, branchId: 'main' }
    assert(
      (record(await rpc.call('session.methods', { sessionId })).methods as { name: string }[]).some(
        (m) => m.name === 'attachment.import',
      ),
    )
    assert.deepEqual((await host.inbox(target, context.owner)).media, { image: true, paste: true, file: true })
    assert.deepEqual((await host.mediaSearch({ ...target, query: 'résumé' }, context.owner)).files, ['résumé.md'])
    assert.deepEqual((await media.mediaSearch(rpc, { ...target, query: '../' }, context)).files, [])
    const upload = async (kind: 'image' | 'paste', bytes: Buffer, throughHost = false) => {
      const uploadId = randomUUID()
      for (let offset = 0; offset < bytes.length; offset += DIMA_MEDIA_CHUNK_BYTES) {
        const data = bytes.subarray(offset, offset + DIMA_MEDIA_CHUNK_BYTES).toString('base64')
        const request = { ...target, uploadId, kind, offset, totalBytes: bytes.length, data }
        const put = () => (throughHost ? host.mediaUpload(request, context.owner) : media.mediaUpload(rpc, request, context))
        const result = await put()
        assert.equal(result.complete, result.nextOffset === bytes.length)
        if (result.complete) assert.deepEqual(await put(), result)
      }
      return { type: 'upload' as const, uploadId }
    }
    const paste = Buffer.from('中文\r\n第二行\r\n')
    function pngChunk(name: string, data: Buffer) {
      const chunk = Buffer.alloc(12 + data.length)
      chunk.writeUInt32BE(data.length)
      chunk.write(name, 4, 'ascii')
      data.copy(chunk, 8)
      chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
      return chunk
    }
    const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
    const image = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    // Encode a legal ignored ancillary chunk immediately before IEND to exercise the
    // exact remote source-byte cap with a decodable image (no large pixel allocation).
    const payloadSize = DIMA_IMAGE_MAX_BYTES - image.length - 12
    const ancillary = Buffer.alloc(payloadSize + 12)
    ancillary.writeUInt32BE(payloadSize, 0)
    ancillary.write('dsHa', 4, 'ascii')
    ancillary.writeUInt32BE(crc32(ancillary.subarray(4, -4)), ancillary.length - 4)
    await upload('image', Buffer.concat([image.subarray(0, -12), ancillary, image.subarray(-12)]))
    // Fork before this image exists. The same Session owns the file, but this
    // sibling cannot name an image absent from its committed input history.
    await host.submit({ ...target, requestId: randomUUID(), text: 'Fixture starting point' }, context.owner)
    const idle = async (branchId: string) => {
      if ((await host.status({ ...target, branchId }, context.owner)).running)
        await host.interrupt({ ...target, branchId }, context.owner)
      const end = Date.now() + 8_000
      while ((await host.status({ ...target, branchId }, context.owner)).running) {
        if (Date.now() > end) throw new Error('Fixture turn remained active')
        await new Promise((r) => setTimeout(r, 30))
      }
    }
    await idle(target.branchId)
    const earlierBranch = await host.act(
      { ...target, kind: 'branchCreate', text: 'fixture child', operationId: randomUUID() },
      context.owner,
    )
    assert(earlierBranch.newBranchId)
    const img = await upload('image', image, true)
    const pasted = await upload('paste', paste, true)
    const request = {
      ...target,
      requestId: randomUUID(),
      mode: 'queue' as const,
      parts: [{ type: 'text' as const, text: 'begin' }, img, { type: 'file' as const, path: 'résumé.md' }, pasted],
    }
    await assert.rejects(host.mediaSubmit(request, 'another-peer'), { code: 'DIMA_NOT_FOUND' })
    assert.equal((await host.mediaSubmit(request, context.owner)).requestId, request.requestId)
    assert.equal((await host.mediaSubmit(request, context.owner)).requestId, request.requestId)
    const receipt = record(await rpc.call('session.input_lookup', { ...target, submissionId: request.requestId }))
    const nativeEvent = record(receipt.event)
    const event = record(nativeEvent.data)
    const blocks = record(event.user).content as Array<{ text?: string; type: string; source?: { type: string } }>
    assert.deepEqual(
      blocks.map((p) => p.type),
      ['text', 'image', 'text', 'text'],
    )
    assert.equal(blocks[1]!.source?.type, 'file')
    const source = record(blocks[1]!.source)
    assert(typeof source.fileId === 'string' && source.mediaType === 'image/png' && typeof nativeEvent.sequence === 'number')
    const reference: DimaImageReference = {
      ...target,
      fileId: source.fileId,
      mediaType: source.mediaType,
      sequence: nativeEvent.sequence,
    }
    const load = (ref: DimaImageReference) =>
      readDimaImage(ref, (p) => host.mediaRead(p, context.owner), AbortSignal.timeout(10_000))
    assert.deepEqual(Buffer.from((await load(reference)).bytes), image)
    await assert.rejects(load({ ...reference, branchId: earlierBranch.newBranchId }), { code: 'DIMA_NOT_FOUND' })
    await assert.rejects(load({ ...reference, fileId: randomUUID() }), { code: 'DIMA_NOT_FOUND' })
    await assert.rejects(load({ ...reference, mediaType: 'image/gif' }), { code: 'DIMA_NOT_FOUND' })
    await idle(target.branchId)
    const child = { ...target, branchId: earlierBranch.newBranchId }
    await idle(child.branchId)
    const own = record(
      record(
        await rpc.call('session.submit', {
          ...child,
          submissionId: randomUUID(),
          mode: 'queue',
          user: { content: [blocks[1]] },
        }),
      ).event,
    )
    assert(typeof own.sequence === 'number')
    const onChild = { ...reference, ...child, sequence: own.sequence }
    await idle(child.branchId)
    await host.act({ ...child, kind: 'endBranch', operationId: randomUUID() }, context.owner)
    let timeline = await host.timeline(child, context.owner)
    const visible = () =>
      timeline.turns.some((turn) =>
        turn.blocks.some(
          (block) =>
            block.kind === 'user' &&
            block.sequence === onChild.sequence &&
            block.attachments?.some((a) => a.fileId === source.fileId),
        ),
      )
    for (let i = 0; !visible() && timeline.earlier && i < 20; i++)
      timeline = await host.timeline({ ...child, cursor: timeline.earlier }, context.owner)
    assert(visible(), 'Expected the committed child input in the paged timeline')
    assert.deepEqual(Buffer.from((await load(onChild)).bytes), image)
    assert.match(blocks[2]!.text!, /résumé.md$/)
    const saved = /^\[Pasted text: (.+) \(2 lines\)\]$/.exec(blocks[3]!.text!)?.[1]
    assert(saved && path.relative(home, saved).split(path.sep)[0] !== '..')
    assert.deepEqual(await readFile(saved), paste)
    await upload('paste', Buffer.alloc(DIMA_PASTE_MAX_BYTES, 97))
    const escapedBudget = 16 * 1024 * 1024 - rpc.requestFrameBytes('attachment.put', { sessionId, text: '' })
    const exactlyOneFrame = '"'.repeat(Math.floor(escapedBudget / 2)) + 'a'.repeat(escapedBudget % 2)
    assert.equal(rpc.requestFrameBytes('attachment.put', { sessionId, text: exactlyOneFrame }), 16 * 1024 * 1024)
    await upload('paste', Buffer.from(exactlyOneFrame))
    await assert.rejects(upload('paste', Buffer.from(exactlyOneFrame + 'a')), { code: 'DIMA_LIMIT_EXCEEDED' })
    await assert.rejects(upload('paste', Buffer.alloc(DIMA_PASTE_MAX_BYTES, 0)), { code: 'DIMA_LIMIT_EXCEEDED' })
    await assert.rejects(upload('image', Buffer.from('not an image')), { code: 'DIMA_REQUEST_FAILED' })
    await assert.rejects(upload('image', Buffer.alloc(DIMA_IMAGE_MAX_BYTES + 1, 0)))
    await assert.rejects(upload('paste', Buffer.alloc(DIMA_PASTE_MAX_BYTES + 1, 97)))
    console.log(
      'Native file search, ordered mixed input, pre-commit sibling denial, ended-branch image preview, 16 MiB PNG import, UTF-8/CRLF, UUID replay, 10 MiB paste, frame and media limits verified.',
    )
  })
} finally {
  clearTimeout(deadline)
  media.clear()
  host.dispose()
  startup.close()
  daemon.kill()
  await exited
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
