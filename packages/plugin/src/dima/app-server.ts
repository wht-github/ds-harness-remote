import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  dimaCreateRequestSchema, dimaHistoryQuerySchema, dimaHistoryRequestSchema, dimaRespondRequestSchema, dimaSubmitRequestSchema,
  type DimaCatalog, type DimaCreateRequest, type DimaCreateResult, type DimaHistory, type DimaHistoryQuery, type DimaHistoryRequest,
  type DimaRespondRequest, type DimaRespondResult, type DimaStatus, type DimaSubmitRequest, type DimaSubmitResult,
  dimaFeatures, dimaOperations, type DimaFeatures, type DimaOperation, type DimaOperationRequest, type DimaOperationResult,
} from '@dsh-remote/protocol'
import type { DimaExtensionGrant } from '../config.js'
import { DimaActions } from './actions.js'
import { readDimaExtensionGrants } from './extensions-policy.js'
import { extensionOperations, listExtensions, setExtension } from './extensions.js'
import { DimaMedia } from './media.js'
import * as taskService from './tasks.js'
import { readDimaTimeline, timelineAvailable } from './timeline.js'
import { branchSnapshot, limited, mutation, notFound, Receipts, ReviewedApprovals } from './interaction.js'
import { RpcError } from '../safe-error.js'
import { invalidReply, record, tooLarge, unavailable, unknownOutcome, withNativeRpc, type DimaOptions, type NativeRpc } from './native-rpc.js'

const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_SESSIONS = 2048
const CATALOG_PAGE_SIZE = 64
const MAX_HISTORY_PAGES = 64
const HISTORY_PAGE_SIZE = 128
const REQUIRED_FEATURES = ['session.catalog', 'session.branches', 'session.history']
const INTERACTION_FEATURES = ['session.create', 'session.submit', 'session.input_lookup', 'session.stop', 'session.attach.expectedCwd', 'session.history.latestTurn']
type Hello = { instanceId: string; features: string[] }
type BranchContext = Hello & { owner: string; cwd: string; head: unknown; state: 'open' | 'ending' | 'ended' }

/** Native hello declares the methods available at this daemon. Session plugins can narrow these further. */
function operationFeatures(hello: Hello | undefined): DimaFeatures {
  const flags = dimaFeatures([])
  if (!hello) return flags
  const { features } = hello
  flags.read = true
  flags.interaction = INTERACTION_FEATURES.every(feature => features.includes(feature))
  flags.timeline = timelineAvailable(features)
  if (features.includes('session.attach.expectedCwd') && features.includes('session.methods')) {
    flags.inbox = true
    flags.options = true
    flags.act = true
    flags.mediaRead = flags.timeline
    flags.mediaSearch = true
    flags.mediaSubmit = features.includes('session.submit') && features.includes('session.input_lookup')
    flags.mediaUpload = flags.mediaSubmit
    for (const operation of taskService.tasksSupportedOperations(features)) flags[operation] = true
  }
  for (const operation of extensionOperations(features)) flags[operation] = true
  return flags
}

type Session = DimaCatalog['workspaces'][number]['sessions'][number]
type Message = DimaHistory['messages'][number]

function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || value.includes('\0')) throw invalidReply()
  return value
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidReply()
  return value
}

function cursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidReply()
  return value
}

async function* catalogRows(rpc: NativeRpc) {
  const sessions = new Set<string>()
  const cursors = new Set<string>()
  let nextCursor: string | undefined
  do {
    // withPreview is a filter: true excludes newly created sessions until their first user input.
    const page = record(await rpc.call('session.catalog', { limit: CATALOG_PAGE_SIZE, withPreview: false, ...(nextCursor && { cursor: nextCursor }) }))
    const rows = array(page.sessions)
    if (rows.length > CATALOG_PAGE_SIZE) throw invalidReply()
    for (const item of rows) {
      const row = record(item)
      const sessionId = id(row.sessionId)
      if (sessions.has(sessionId)) throw invalidReply()
      sessions.add(sessionId)
      if (sessions.size > MAX_SESSIONS) throw tooLarge()
      if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || row.cwd.includes('\0') || row.cwd.length > 32_768) throw invalidReply()
      if (row.title != null && typeof row.title !== 'string') throw invalidReply()
      if (row.preview != null && typeof row.preview !== 'string') throw invalidReply()
      const title = String(row.title || row.preview || sessionId).slice(0, 8192)
      yield { sessionId, cwd: row.cwd, title }
    }
    if (page.nextCursor === undefined) return
    if (!rows.length || typeof page.nextCursor !== 'string' || !page.nextCursor.length || page.nextCursor.length > 8192 || cursors.has(page.nextCursor)) throw invalidReply()
    nextCursor = page.nextCursor
    cursors.add(nextCursor)
  } while (nextCursor)
}

async function catalogWorkspace(rpc: NativeRpc, cwd: string): Promise<void> {
  for await (const row of catalogRows(rpc)) {
    if (row.cwd !== cwd) continue
    const localPath = process.platform === 'win32' ? cwd.replace(/^\\\\\?\\([a-z]:\\)/i, '$1') : cwd
    if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(localPath)) throw notFound()
    const resolved = await realpath(localPath).catch(() => undefined)
    if (!resolved || path.relative(resolved, localPath) || !(await stat(resolved)).isDirectory()) throw notFound()
    return
  }
  throw notFound()
}

async function branchDirectory(rpc: NativeRpc, sessionId: string) {
  const reply = record(await rpc.call('session.branches', { sessionId }))
  const rows = array(reply.branches)
  if (rows.length > 8192) throw tooLarge()
  const directory = new Map<string, Record<string, unknown>>()
  for (const item of rows) {
    const row = record(item)
    const branchId = id(row.branchId)
    if (directory.has(branchId)) throw invalidReply()
    directory.set(branchId, row)
  }
  const current = id(reply.defaultBranchId)
  if (!directory.has(current)) throw invalidReply()
  return { current, directory }
}

async function selectBranch(rpc: NativeRpc, target: DimaHistoryRequest) {
  for await (const row of catalogRows(rpc)) {
    if (row.sessionId !== target.sessionId) continue
    const { directory } = await branchDirectory(rpc, row.sessionId)
    const branch = directory.get(target.branchId)
    if (!branch) break
    return { cwd: row.cwd, state: branch.state, head: branch.head }
  }
  throw notFound()
}

async function snapshot(rpc: NativeRpc, target: DimaHistoryRequest, review = true) {
  const { cwd, state } = await selectBranch(rpc, target)
  if (state === 'ended') return { ...target, running: false, stopping: false, approvals: [] }
  if (state !== 'open' && state !== 'ending') throw invalidReply()
  return branchSnapshot(rpc, target, cwd, review)
}

function userText(user: unknown): string {
  const content = array(record(user).content)
  const text: string[] = []
  for (const [index, item] of content.entries()) {
    const block = record(item)
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') throw invalidReply()
    // The official client treats trailing Skill/Hook context as runtime input.
    if (index > 0 && /^<dim-(?:skill|hooks)(?:>|\s)/.test(block.text)) continue
    text.push(block.text)
  }
  return text.join('\n')
}

/** Keep the nearest complete Unicode slice within the escaped JSON byte budget. */
function fitText(text: string, bytes: number, recent: boolean): string {
  let low = 0
  let high = Math.min(text.length, Math.max(0, bytes))
  const slice = (length: number) => recent ? text.slice(text.length - length) : text.slice(0, length)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(slice(mid))) - 2 <= bytes) low = mid
    else high = mid - 1
  }
  const edge = recent ? text.length - low : low
  if (text.charCodeAt(edge - 1) >= 0xd800 && text.charCodeAt(edge - 1) <= 0xdbff &&
      text.charCodeAt(edge) >= 0xdc00 && text.charCodeAt(edge) <= 0xdfff) low--
  return slice(low)
}

/** Follow only native cursors. An arbitrary sequence can land inside a committed batch. */
async function* historyPages(rpc: NativeRpc, target: DimaHistoryRequest, recent: boolean) {
  let through: number | undefined
  let position = 0
  for (let i = 0; i < (recent ? 4 : MAX_HISTORY_PAGES); i++) {
    const window = recent ? (position ? { before: position } : { latestTurn: true }) : { after: position }
    const page = record(await rpc.call('session.history', { ...target, ...window, ...(through !== undefined && { through }), limit: HISTORY_PAGE_SIZE }))
    const head = cursor(page.through)
    const last = cursor(page.nextAfter)
    const first = recent && page.nextBefore != null ? cursor(page.nextBefore) : undefined
    const events = array(page.events).map(record)
    if (typeof page.done !== 'boolean' || (through !== undefined && head !== through) || last > head) throw invalidReply()
    if (recent) {
      if (first === undefined ? (!page.done || events.length > 0)
        : first < 1 || first > last || (position > 0 && last >= position)) throw invalidReply()
    } else if (last < position || (page.done ? last !== head : last <= position)) throw invalidReply()
    let previous = recent ? (first ?? 1) - 1 : position
    for (const event of events) {
      const sequence = cursor(event.sequence)
      if (sequence <= previous || sequence > last || typeof event.type !== 'string' || typeof event.name !== 'string') throw invalidReply()
      previous = sequence
    }
    const more = recent ? (first ?? 1) > 1 : !page.done
    yield { events, more }
    if (!more) return
    through = head
    position = recent ? first! : last
  }
}

async function readHistory(rpc: NativeRpc, target: DimaHistoryRequest, recent = false): Promise<DimaHistory> {
  const result: DimaHistory = { ...target, messages: [], truncated: false }
  const assistants = new Map<string, Message>()
  const firstEvent = new Map<Message, number>()
  // Reserve the serialized space for an optional terminal outcome in the recent window.
  let bytes = Buffer.byteLength(JSON.stringify(result)) + (recent ? 16 * 1024 : 0)
  let checkedOutcome = !recent
  let visited = 0
  const maxEvents = MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE
  for await (const { events, more } of historyPages(rpc, target, recent)) {
    result.truncated = false
    for (const event of recent ? events.reverse() : events) {
      if (++visited > maxEvents) { result.truncated = true; break }
      if (event.parent_call_id != null) continue
      if (!checkedOutcome && (event.type === 'turn' && (event.name === 'start' || event.name === 'end')
          || event.type === 'input' && event.name === 'message' && record(event.data).user != null)) {
        checkedOutcome = true
        if (event.type === 'turn' && event.name === 'end') {
          const data = record(event.data)
          if (data.status === 'failed' || data.status === 'cancelled') {
            const detail = data.status === 'failed' ? data.error : data.reason
            result.lastTurnIssue = { status: data.status, detail: typeof detail === 'string' ? detail.slice(0, 2048) : '' }
          }
        }
      }
      let message: Message
      let existing: Message | undefined
      if (event.type === 'input' && event.name === 'message') {
        const data = record(event.data)
        if (data.user == null) continue
        message = { role: 'user', text: userText(data.user) }
      } else if (event.type === 'step' && event.name === 'text') {
        const data = record(event.data)
        const requestId = id(data.request_id)
        if (typeof data.delta !== 'string') throw invalidReply()
        message = { role: 'assistant', text: data.delta }
        existing = assistants.get(requestId)
        if (!existing && message.text.length) assistants.set(requestId, message)
      } else continue
      if (!message.text) continue
      const overhead = existing ? 0 : Buffer.byteLength(JSON.stringify({ role: message.role, text: '' })) + 1
      const available = MAX_RESULT_BYTES - bytes - overhead
      const textBytes = Buffer.byteLength(JSON.stringify(message.text)) - 2
      if (textBytes > available) {
        message.text = fitText(message.text, available, recent)
        result.truncated = true
      }
      if (recent) firstEvent.set(existing ?? message, event.sequence as number)
      if (existing) existing.text = recent ? message.text + existing.text : existing.text + message.text
      else if (message.text) result.messages.push(message)
      if (result.truncated) break
      bytes += overhead + textBytes
    }
    if (result.truncated) break
    result.truncated = more
    if (recent && result.messages.length && visited >= HISTORY_PAGE_SIZE) break
  }
  // A queued user message can fall between two chunks of the same model reply.
  if (recent) result.messages.sort((a, b) => firstEvent.get(a)! - firstEvent.get(b)!)
  return result
}

export class DimaAppServer {
  private active = 0
  private readonly waiting = new Set<() => void>()
  private readonly shutdown = new AbortController()
  private readonly creating = new Receipts<DimaCreateResult>()
  private readonly submitting = new Receipts<DimaSubmitResult>()
  private readonly approvals = new ReviewedApprovals()
  private readonly writing = new Set<string>()
  private probing?: Promise<Hello | undefined>
  private lastProbe?: { hello?: Hello; expires: number; verified: number }

  private readonly actions = new DimaActions()
  private readonly media = new DimaMedia()
  private readonly extensionChanges = new Receipts<DimaOperationResult<'setExtension'>>()
  private readonly goalChanges = new Receipts<DimaOperationResult<'goalUpdate'>>()
  private readonly taskStops = new Receipts<DimaOperationResult<'taskStop'>>()

  constructor(private readonly nativeOptions: DimaOptions = {}, private readonly readGrants: () => readonly DimaExtensionGrant[] = readDimaExtensionGrants) {}

  private capabilities(): Promise<Hello | undefined> {
    if (this.shutdown.signal.aborted) return Promise.resolve(undefined)
    if (this.lastProbe && Date.now() < this.lastProbe.expires) return Promise.resolve(this.lastProbe.hello)
    this.probing ??= this.run(1500, async (_rpc, hello) => hello, this.shutdown.signal).then(hello => {
      const now = Date.now()
      this.lastProbe = { hello, expires: now + 2500, verified: now }
      return hello
    }, error => {
      const now = Date.now(), prior = this.lastProbe
      const busy = error instanceof RpcError && (error.code === 'RATE_LIMITED' || error.code === 'DIMA_TIMEOUT')
      // A busy Host can share its last successful handshake briefly. Every operation still checks its own live hello.
      if (busy && prior?.hello && now < prior.verified + 10_000) {
        prior.expires = Math.min(now + 1500, prior.verified + 10_000)
        return prior.hello
      }
      this.lastProbe = { expires: now + 2500, verified: 0 }
      return undefined
    }).finally(() => { this.probing = undefined })
    return this.probing
  }

  async probe(): Promise<boolean> { return Boolean(await this.capabilities()) }

  async features(): Promise<DimaFeatures> { return operationFeatures(await this.capabilities()) }

  async interactionAvailable(): Promise<boolean> {
    const hello = await this.capabilities()
    return !!hello && INTERACTION_FEATURES.every(feature => hello.features.includes(feature))
  }

  dispose() {
    this.shutdown.abort()
    this.approvals.clear()
    this.actions.clear()
    this.media.clear()
    this.extensionChanges.clear()
    this.goalChanges.clear()
    this.taskStops.clear()
    this.creating.clear()
    this.submitting.clear()
  }

  catalog(): Promise<DimaCatalog> {
    return this.run(15_000, async rpc => {
      const workspaces = new Map<string, Session[]>()
      let bytes = Buffer.byteLength('{"workspaces":[]}')
      for await (const { sessionId, title, cwd } of catalogRows(rpc)) {
        let sessions = workspaces.get(cwd)
        if (!sessions) {
          sessions = []
          workspaces.set(cwd, sessions)
          bytes += Buffer.byteLength(JSON.stringify({ cwd, sessions })) + 1
        }
        const { current, directory } = await branchDirectory(rpc, sessionId)
        directory.delete(current)
        const session = { sessionId, title, branches: [current, ...directory.keys()] }
        bytes += Buffer.byteLength(JSON.stringify(session)) + 1
        if (bytes > MAX_RESULT_BYTES) throw tooLarge()
        sessions.push(session)
      }
      return { workspaces: [...workspaces].map(([cwd, sessions]) => ({ cwd, sessions })) }
    })
  }

  async history(input: DimaHistoryQuery, signal?: AbortSignal): Promise<DimaHistory> {
    const { window, ...target } = dimaHistoryQuerySchema.parse(input)
    return this.run(15_000, async rpc => {
      await selectBranch(rpc, target)
      return readHistory(rpc, target, window === 'recent')
    }, signal)
  }

  async create(input: DimaCreateRequest, owner: string): Promise<DimaCreateResult> {
    const { cwd, requestId } = dimaCreateRequestSchema.parse(input)
    this.requireOwner(owner)
    return this.creating.once(owner, requestId, cwd, () => this.interact(async rpc => {
      await catalogWorkspace(rpc, cwd)
      return mutation(async () => {
        const created = record(await rpc.call('session.create', { cwd }))
        const sessionId = id(created.sessionId)
        cursor(created.sequence)
        // The creation is already committed if this follow-up read fails.
        const { current } = await branchDirectory(rpc, sessionId).catch(() => { throw unknownOutcome() })
        return { cwd, sessionId, branchId: current }
      })
    }))
  }

  async submit(input: DimaSubmitRequest, owner: string): Promise<DimaSubmitResult> {
    const { sessionId, branchId, requestId, text } = dimaSubmitRequestSchema.parse(input)
    this.requireOwner(owner)
    const target = { sessionId, branchId }
    return this.submitting.once(owner, requestId, [sessionId, branchId, text], () => this.writeBranch(target, async rpc => {
      const { state } = await selectBranch(rpc, target)
      const identity = { ...target, submissionId: requestId }
      const lookup = record(await rpc.call('session.input_lookup', identity))
      const confirm = (receipt: Record<string, unknown>) => {
        const event = record(receipt.event)
        const data = record(event.data)
        if (event.type !== 'input' || event.name !== 'message' || data.submission_id !== requestId) throw invalidReply()
        const first = record(array(record(data.user).content)[0])
        if (first.type !== 'text' || first.text !== text) throw new RpcError('DIMA_REQUEST_CONFLICT', 'The native input receipt belongs to different content.')
        return { ...target, requestId }
      }
      if (lookup.status === 'accepted') return confirm(lookup)
      if (lookup.status !== 'unknown') throw invalidReply()
      if (state !== 'open') throw notFound()
      return mutation(async () => confirm(record(await rpc.call('session.submit', { ...identity, mode: 'queue', text }))))
    }))
  }

  async status(input: DimaHistoryRequest, owner: string, signal?: AbortSignal): Promise<DimaStatus> {
    const target = dimaHistoryRequestSchema.parse(input)
    this.requireOwner(owner)
    return this.interact(async (rpc, hello) => {
      const status = await snapshot(rpc, target)
      this.approvals.show(owner, hello.instanceId, status)
      return status
    }, 15_000, signal)
  }

  async interrupt(input: DimaHistoryRequest, owner: string): Promise<DimaHistoryRequest> {
    const target = dimaHistoryRequestSchema.parse(input)
    this.requireOwner(owner)
    return this.writeBranch(target, async rpc => {
      const current = await snapshot(rpc, target, false)
      if (current.stopping) return target
      if (!current.running) throw new RpcError('DIMA_NOT_RUNNING', 'The selected DimAgent branch is idle.')
      return mutation(async () => {
        cursor(record(await rpc.call('session.stop', target)).sequence)
        return target
      })
    })
  }

  async respond(input: DimaRespondRequest, owner: string): Promise<DimaRespondResult> {
    const { sessionId, branchId, requestId, decision } = dimaRespondRequestSchema.parse(input)
    const target = { sessionId, branchId }
    this.requireOwner(owner)
    return this.writeBranch(target, async (rpc, hello) => {
      const current = await snapshot(rpc, target)
      this.approvals.consume(owner, hello.instanceId, target, current.approvals?.find(p => p.requestId === requestId))
      return mutation(async () => {
        const reply = record(await rpc.call('approval.respond', { ...target, requestId, decision }))
        if (Object.keys(reply).length) throw invalidReply()
        return { ...target, requestId }
      })
    })
  }

  timeline(input: DimaOperationRequest<'timeline'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.timeline.request.parse(input)
    this.requireOwner(owner)
    return this.runOperation('timeline', signal, async (rpc, hello) => {
      const { cwd, state } = await selectBranch(rpc, query)
      return readDimaTimeline(rpc, query, { ...hello, cwd, state })
    })
  }

  extensions(input: DimaOperationRequest<'extensions'>, owner: string, signal?: AbortSignal) {
    const { cwd } = dimaOperations.extensions.request.parse(input)
    this.requireOwner(owner)
    return this.runOperation('extensions', signal, async (rpc, hello) => {
      await catalogWorkspace(rpc, cwd)
      return listExtensions(rpc, hello.features, cwd, this.readGrants)
    })
  }

  setExtension(input: DimaOperationRequest<'setExtension'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.setExtension.request.parse(input)
    this.requireOwner(owner)
    // A Host-scoped toggle can be reached from any workspace. Serialize the review and write across them.
    return this.extensionChanges.once(owner, query.operationId, query, () => this.withWriteLock('extensions', () =>
      this.runOperation('setExtension', signal, async (rpc, hello) => {
        await catalogWorkspace(rpc, query.cwd)
        return setExtension(rpc, hello.features, query.cwd, query, this.readGrants)
      })))
  }

  inbox(input: DimaOperationRequest<'inbox'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.inbox.request.parse(input)
    return this.onBranch('inbox', query, owner, false, signal,
      (rpc, context) => this.actions.inbox(rpc, query, context))
  }

  options(input: DimaOperationRequest<'options'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.options.request.parse(input)
    return this.onBranch('options', query, owner, false, signal,
      (rpc, context) => this.actions.options(rpc, query, context))
  }

  act(input: DimaOperationRequest<'act'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.act.request.parse(input)
    return this.onBranch('act', query, owner, true, signal,
      (rpc, context) => this.actions.act(rpc, query, context), query.kind === 'compact' ? 120_000 : 15_000)
  }

  mediaRead(input: DimaOperationRequest<'mediaRead'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.mediaRead.request.parse(input)
    return this.onBranch('mediaRead', query, owner, false, signal, (rpc, context) => {
      if (query.sequence > cursor(context.head)) throw notFound()
      return this.media.mediaRead(rpc, query)
    })
  }

  mediaSearch(input: DimaOperationRequest<'mediaSearch'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.mediaSearch.request.parse(input)
    return this.onBranch('mediaSearch', query, owner, false, signal,
      (rpc, context) => this.media.mediaSearch(rpc, query, context))
  }

  mediaUpload(input: DimaOperationRequest<'mediaUpload'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.mediaUpload.request.parse(input)
    return this.onBranch('mediaUpload', query, owner, true, signal,
      (rpc, context) => this.media.mediaUpload(rpc, query, context))
  }

  mediaSubmit(input: DimaOperationRequest<'mediaSubmit'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.mediaSubmit.request.parse(input)
    return this.onBranch('mediaSubmit', query, owner, true, signal,
      (rpc, context) => this.media.mediaSubmit(rpc, query, context))
  }

  goal(input: DimaOperationRequest<'goal'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.goal.request.parse(input)
    return this.onBranch('goal', query, owner, false, signal,
      (rpc, context) => taskService.goal(rpc, query, context.features))
  }

  goalUpdate(input: DimaOperationRequest<'goalUpdate'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.goalUpdate.request.parse(input)
    this.requireOwner(owner)
    return this.goalChanges.once(owner, query.operationId, query, () => this.onBranch('goalUpdate', query, owner, true, signal,
      (rpc, context) => taskService.goalUpdate(rpc, query, context.features)))
  }

  tasks(input: DimaOperationRequest<'tasks'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.tasks.request.parse(input)
    return this.onBranch('tasks', query, owner, false, signal,
      (rpc, context) => taskService.tasks(rpc, query, context.features))
  }

  taskDetail(input: DimaOperationRequest<'taskDetail'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.taskDetail.request.parse(input)
    return this.onBranch('taskDetail', query, owner, false, signal,
      (rpc, context) => taskService.taskDetail(rpc, query, context.features))
  }

  taskStop(input: DimaOperationRequest<'taskStop'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.taskStop.request.parse(input)
    this.requireOwner(owner)
    return this.taskStops.once(owner, query.operationId, query, () => this.onBranch('taskStop', query, owner, true, signal,
      (rpc, context) => taskService.taskStop(rpc, query, context.features)))
  }

  conversationExport(input: DimaOperationRequest<'conversationExport'>, owner: string, signal?: AbortSignal) {
    const query = dimaOperations.conversationExport.request.parse(input)
    return this.onBranch('conversationExport', query, owner, false, signal,
      (rpc, context) => taskService.conversationExport(rpc, query, context.features))
  }

  private requireOwner(owner: string) {
    if (!owner) throw new RpcError('UNAUTHORIZED', 'DimAgent interaction requires an authenticated caller.')
    if (this.shutdown.signal.aborted) throw unavailable()
  }

  /** Validate the catalog branch and attach only to the native session at its catalogued cwd. */
  private onBranch<T>(operation: DimaOperation, target: DimaHistoryRequest, owner: string, write: boolean, signal: AbortSignal | undefined, work: (rpc: NativeRpc, context: BranchContext) => Promise<T>, timeout = 15_000): Promise<T> {
    this.requireOwner(owner)
    const checked = async (rpc: NativeRpc, hello: Hello) => {
      const { cwd, state, head } = await selectBranch(rpc, target)
      if (state !== 'open' && state !== 'ending' && state !== 'ended') throw invalidReply()
      // act handles a closed branch after checking its receipt. In particular, ending a branch
      // must still let the same caller retrieve the acknowledgement for that exact operation.
      if (write && operation !== 'act' && state !== 'open') throw notFound()
      if (state !== 'ended' || operation === 'mediaRead') {
        const attached = record(await rpc.call('session.attach', { sessionId: target.sessionId, expectedCwd: cwd }))
        if (attached.sessionId !== target.sessionId || attached.cwd !== cwd) throw invalidReply()
      }
      return work(rpc, { ...hello, owner, cwd, state, head })
    }
    const run = () => this.runOperation(operation, signal, checked, timeout)
    return write ? this.withWriteLock(JSON.stringify([target.sessionId, target.branchId]), run) : run()
  }

  private async writeBranch<T>(target: DimaHistoryRequest, work: (rpc: NativeRpc, hello: Hello) => Promise<T>, timeout = 15_000): Promise<T> {
    return this.withWriteLock(JSON.stringify([target.sessionId, target.branchId]), () => this.interact(work, timeout))
  }

  private async withWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.writing.has(key)) throw new RpcError('AGENT_BUSY', 'Another DimAgent operation is in progress on this branch.')
    this.writing.add(key)
    try { return await work() } finally { this.writing.delete(key) }
  }

  private runOperation<T>(operation: DimaOperation, signal: AbortSignal | undefined, work: (rpc: NativeRpc, hello: Hello) => Promise<T>, timeout = 15_000): Promise<T> {
    return this.run(timeout, (rpc, hello) => {
      if (!operationFeatures(hello)[operation]) throw new RpcError('FEATURE_NOT_SUPPORTED', 'DimAgent does not support this operation.')
      return work(rpc, hello)
    }, signal)
  }

  private interact<T>(work: (rpc: NativeRpc, hello: Hello) => Promise<T>, timeout = 15_000, signal?: AbortSignal): Promise<T> {
    return this.run(timeout, (rpc, hello) => {
      if (!INTERACTION_FEATURES.every(feature => hello.features.includes(feature))) {
        throw new RpcError('DIMA_INCOMPATIBLE', 'DimAgent lacks the required native interaction capabilities.')
      }
      return work(rpc, hello)
    }, signal)
  }

  /** Each desktop or phone can read the timeline, status and inbox at once. Keep native pipes bounded
   * and queue short bursts from authenticated connections within their original deadline. */
  private async acquire(signal: AbortSignal, allowWait: boolean): Promise<void> {
    signal.throwIfAborted()
    if (this.active < 4) { this.active++; return }
    if (!allowWait || this.waiting.size >= 16) throw limited()
    await new Promise<void>((resolve, reject) => {
      const granted = () => { signal.removeEventListener('abort', cancelled); resolve() }
      const cancelled = () => { this.waiting.delete(granted); reject(signal.reason) }
      this.waiting.add(granted)
      signal.addEventListener('abort', cancelled, { once: true })
    })
  }

  private async run<T>(timeout: number, work: (rpc: NativeRpc, hello: Hello) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (this.shutdown.signal.aborted) throw unavailable()
    const signals = [this.shutdown.signal, AbortSignal.timeout(timeout)]
    if (caller) signals.push(caller)
    const signal = AbortSignal.any(signals)
    let acquired = false
    try {
      await this.acquire(signal, caller !== undefined)
      acquired = true
      signal.throwIfAborted()
      return await withNativeRpc(this.nativeOptions, signal, async rpc => {
        const hello = record(await rpc.call('hello', { protocolVersion: 4, clientKind: 'other', clientName: 'ds-harness-remote' }))
        if (hello.protocolVersion !== 4 || typeof hello.instanceId !== 'string' || !hello.instanceId
          || typeof hello.serverVersion !== 'string' || !hello.serverVersion
          || !Array.isArray(hello.features) || !hello.features.every(f => typeof f === 'string')
          || !REQUIRED_FEATURES.every(feature => (hello.features as unknown[]).includes(feature))) {
          throw new RpcError('DIMA_INCOMPATIBLE', 'DimAgent lacks the required native read capabilities.')
        }
        return work(rpc, { instanceId: hello.instanceId, features: hello.features })
      })
    } catch (error) {
      if (error instanceof RpcError && error.code === 'DIMA_OUTCOME_UNKNOWN') throw error
      if (this.shutdown.signal.aborted) throw unavailable()
      if (caller?.aborted) throw new RpcError('TRANSPORT_CLOSED', 'The DimAgent connection closed.')
      if (signal.aborted) throw new RpcError('DIMA_TIMEOUT', 'DimAgent timed out.')
      if (error instanceof RpcError) throw error
      throw unavailable()
    } finally {
      if (acquired) {
        const next = this.waiting.values().next().value
        if (next) { this.waiting.delete(next); next() }
        else this.active--
      }
    }
  }
}
