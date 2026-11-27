import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { resolveNpmCmdShim } from '../acp/windows-spawn.js'
import { RpcError } from '../safe-error.js'

export interface DimaOptions {
  /** Product home passed to the local dima CLI with --home. */
  home?: string
  /** Absolute path to the installed native dimcode executable on Windows. */
  binary?: string
}

const canonicalPath = promisify(realpath.native)
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_READ_BYTES = 32 * 1024 * 1024
export const unknownOutcome = () => new RpcError('DIMA_OUTCOME_UNKNOWN', 'The DimAgent operation could not be confirmed. Refresh before acting again.')
export const unavailable = () => new RpcError('DIMA_UNAVAILABLE', 'DimAgent App Server is unavailable.')
export const invalidReply = () => new RpcError('DIMA_PROTOCOL_ERROR', 'DimAgent returned an invalid response.')
export const tooLarge = () => new RpcError('DIMA_LIMIT_EXCEEDED', 'DimAgent data exceeds the read limit.')

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidReply()
  return value as Record<string, unknown>
}

async function* frames(stream: Readable, maxFrame = MAX_FRAME_BYTES): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let parts: Buffer[] = []
  let size = 0
  let total = 0
  for await (const chunk of stream) {
    const buffer: Buffer = chunk
    total += buffer.length
    if (total > MAX_READ_BYTES) throw tooLarge()
    let start = 0
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start)
      const part = buffer.subarray(start, end < 0 ? buffer.length : end)
      size += part.length
      if (size > maxFrame) throw tooLarge()
      parts.push(part)
      if (end < 0) break
      let value: unknown
      try { value = JSON.parse(decoder.decode(Buffer.concat(parts, size))) } catch { throw invalidReply() }
      parts = []
      size = 0
      start = end + 1
      yield value
    }
  }
  if (size) throw invalidReply()
}

type NativeMethod = 'hello' | 'session.catalog' | 'session.branches' | 'session.history' | 'session.history.display'
  | (typeof import('./actions.js').dimaActionNativeMethods)[number]
  | (typeof import('./extensions.js').extensionsNativeMethods)[number]
  | (typeof import('./tasks.js').tasksNativeMethods)[number]
  | (typeof import('./media.js').mediaNativeMethods)[number]
  | 'session.create' | 'session.submit' | 'session.input_lookup' | 'session.attach' | 'session.stop' | 'approval.respond'

/** One sequential JSON-RPC connection. No request or endpoint comes from a peer. */
export class NativeRpc {
  private id = 0
  private readonly replies: AsyncGenerator<unknown>

  constructor(reader: Readable, private readonly writer: Writable) {
    this.replies = frames(reader)
  }

  private async frame(): Promise<Record<string, unknown>> {
    const reply = await this.replies.next()
    if (reply.done) throw unavailable()
    const envelope = record(reply.value)
    if (envelope.jsonrpc !== '2.0') throw invalidReply()
    return envelope
  }

  async notification(): Promise<Record<string, unknown>> {
    const envelope = await this.frame()
    if ('id' in envelope || typeof envelope.method !== 'string' || 'result' in envelope || 'error' in envelope) throw invalidReply()
    return envelope
  }

  requestFrameBytes(method: NativeMethod, params: Record<string, unknown>): number {
    return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: this.id + 1, method, params }))
  }

  async call(method: NativeMethod, params: Record<string, unknown>, onNotification?: (notice: Record<string, unknown>) => void): Promise<unknown> {
    const id = ++this.id
    this.writer.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (;;) {
      const envelope = await this.frame()
      if (!('id' in envelope) && typeof envelope.method === 'string' && !('result' in envelope) && !('error' in envelope)) {
        onNotification?.(envelope)
        continue
      }
      if (envelope.id !== id || 'method' in envelope || ('result' in envelope) === ('error' in envelope)) throw invalidReply()
      if ('error' in envelope) {
        const error = record(envelope.error)
        const code = error.data && typeof error.data === 'object' && 'appError' in error.data ? error.data.appError : undefined
        if (code === 'submission_unknown') throw unknownOutcome()
        if (code === 'question_not_pending') throw new RpcError('DIMA_ACTION_STALE', 'This question is no longer pending on the selected branch.')
        if (code === 'context_usage_unavailable') throw new RpcError('DIMA_USAGE_UNAVAILABLE', 'Usage is unavailable for this turn.')
        throw new RpcError('DIMA_REQUEST_FAILED', 'DimAgent could not complete the request.')
      }
      return envelope.result
    }
  }
}

function localAbsolute(value: string): boolean {
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : path.isAbsolute(value)
}

async function windowsBinary(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    if (!localAbsolute(explicit) || !/\.exe$/i.test(explicit)) throw unavailable()
    return explicit
  }
  // Resolve only installed launchers on absolute PATH entries. Never execute a
  // workspace shim, shell command, or a binary supplied by the daemon home.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!localAbsolute(dir)) continue
    if (!path.relative(process.cwd(), dir) || path.basename(dir).toLowerCase() === '.bin') continue
    const executable = path.join(dir, 'dima.exe')
    if ((await stat(executable).catch(() => undefined))?.isFile()) return executable
    const shim = path.join(dir, 'dima.cmd')
    const info = await stat(shim).catch(() => undefined)
    if (!info?.isFile() || info.size > 64 * 1024) continue
    const entry = resolveNpmCmdShim(shim)?.argsPrefix[0]
    if (!entry || !/[\\/]dimcode-alpha[\\/]bin[\\/]dimcode\.mjs$/i.test(entry)) continue
    try {
      const require = createRequire(await canonicalPath(entry))
      const platformManifest = require.resolve('dimcode-windows-' + process.arch + '/package.json')
      return path.join(path.dirname(platformManifest), 'bin', 'dimcode.exe')
    } catch { /* Try the next installation prefix. */ }
  }
  throw unavailable()
}

async function unixEndpoint(nativeHome: string): Promise<string> {
  const uid = process.geteuid?.()
  if (uid === undefined) throw unavailable()
  const directory = await lstat(nativeHome)
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)) throw unavailable()
  // Prevent other users from replacing any path component during connect.
  let ancestor = path.dirname(nativeHome)
  for (;;) {
    const info = await lstat(ancestor)
    if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)
        || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw unavailable()
    const parent = path.dirname(ancestor)
    if (ancestor === parent) break
    ancestor = parent
  }
  const endpoint = path.join(nativeHome, 'daemon.sock')
  const socket = await lstat(endpoint)
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077)) throw unavailable()
  return endpoint
}

export async function withNativeRpc<T>(options: DimaOptions, signal: AbortSignal, work: (rpc: NativeRpc) => Promise<T>): Promise<T> {
  const home = options.home ?? process.env.DIMCODE_HOME ?? path.join(homedir(), '.dimcode-alpha')
  if (!localAbsolute(home)) throw unavailable()
  const nativeHome = await canonicalPath(path.join(home, 'rust'))
  if (!localAbsolute(nativeHome)) throw unavailable()
  let close: (() => void) | undefined
  const onAbort = () => close?.()
  try {
    signal.addEventListener('abort', onAbort, { once: true })
    let rpc: NativeRpc
    if (process.platform === 'win32') {
      // Rust's canonicalize() includes the extended-length prefix in the hash.
      const key = createHash('sha256').update('dimcode:' + path.toNamespacedPath(nativeHome)).digest('hex').slice(0, 32)
      const pipe = String.raw`\\.\pipe\dim-rust-` + key
      const binary = await windowsBinary(options.binary)
      signal.throwIfAborted()
      // The native helper checks the owner SID on the open pipe handle before
      // it announces readiness and begins copying NDJSON. net.connect cannot.
      const child = spawn(binary, ['app-server', '--connect-pipe', pipe], { stdio: 'pipe', windowsHide: true })
      close = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill() }
      child.on('error', onAbort)
      child.stdin.on('error', onAbort)
      const status = frames(child.stderr, 4096)
      const first = await status.next()
      if (first.done || record(first.value).status !== 'ready') throw unavailable()
      rpc = new NativeRpc(child.stdout, child.stdin)
    } else {
      const endpoint = await unixEndpoint(nativeHome)
      signal.throwIfAborted()
      const socket = connect({ path: endpoint })
      close = () => socket.destroy()
      socket.on('error', onAbort)
      rpc = new NativeRpc(socket, socket)
    }
    return await work(rpc)
  } finally {
    signal.removeEventListener('abort', onAbort)
    close?.()
  }
}
