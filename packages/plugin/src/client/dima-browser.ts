import { dimaFeatures } from '@dsh-remote/protocol'
import type { DimaFeatures, DimaActionResult, DimaTimelineRequest } from '@dsh-remote/protocol'
import { createDimaControls, type DimaOperationCall, type DimaLanguage } from './dima-controls-view.js'
import { createDimaTimeline, createDimaMarkdown } from './dima-timeline-view.js'
import type { DimaMediaMemory } from './dima-media.js'
import type { DimaImageRead } from './dima-image-preview.js'
import { DimaTimelineMemory } from './dima-timeline-memory.js'
import { createDimaExtensions } from './dima-extensions-view.js'
import type {
  DimaCatalog, DimaCreateResult, DimaHistory, DimaHistoryRequest, DimaRespondRequest, DimaRespondResult, DimaStatus, DimaSubmitResult,
} from '@dsh-remote/protocol'
import type { Translate } from '../client-locale.js'
import { messageOf } from './presentation.js'
import type { ClientReact, RemoteStatus } from './types.js'

export type DimaSource = { target: 'local' } | { target: 'remote'; targetDeviceId: string }
export function dimaSourceConnection(source: DimaSource, status?: RemoteStatus): string | undefined {
  if (source.target === 'local' || status?.connectedTargetDeviceId !== source.targetDeviceId) return undefined
  const { connectionId, connectedAt } = status.network ?? {}
  if (!connectionId && connectedAt === undefined && status.recoveryGeneration === undefined) return undefined
  return JSON.stringify([source.targetDeviceId, connectionId, connectedAt, status.recoveryGeneration])
}
type Control = <T>(endpoint: string, payload: unknown) => Promise<T>
type ReadResult<T> = { value: T } | { error: unknown }
type Draft = { text: string }
type Edit = { draft?: Draft; pending?: boolean; error?: unknown; revision: number }
type BranchTarget = DimaSource & DimaHistoryRequest
type HistoryWindow = 'recent' | 'prefix'
type BranchRead = {
  target: BranchTarget; window: HistoryWindow; history?: ReadResult<DimaHistory>; status?: ReadResult<DimaStatus>; revision: number
}
type BranchView = Partial<Record<HistoryWindow, ReadResult<DimaHistory>>> & { status?: ReadResult<DimaStatus>; revision: number }
const emptyEdit: Edit = { revision: 0 }

// The workspace action outlives individual dialogs. Keep only in-memory drafts and
// mutation state here so reopening or switching sources cannot retarget a receipt.
export class DimaBrowserMemory {
  readonly timelines = new DimaTimelineMemory()
  readonly navigation = new Map<string, { cwd?: string; sessionId?: string; branchId?: string }>()
  private readonly edits = new Map<string, Edit>()
  private readonly attachments = new Map<string, DimaMediaMemory>()
  media(key: string): DimaMediaMemory {
    let value = this.attachments.get(key)
    if (!value) { value = { items: [] }; this.attachments.set(key, value) }
    return value
  }
  private readonly listeners = new Set<() => void>()
  private readonly reads = new Map<string, Promise<BranchRead | undefined>>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(key: string): Edit { return this.edits.get(key) ?? emptyEdit }

  private set(key: string, edit: Edit): void {
    this.edits.set(key, edit)
    for (const listener of this.listeners) listener()
  }
  editDraft(key: string, text: string): void {
    this.set(key, { ...this.get(key), draft: text ? { text } : undefined })
  }

  // Each source has one outstanding read, even while switching branches or reopening the dialog.
  readBranch(control: Control, target: BranchTarget, interactive: boolean, window: HistoryWindow, visible: () => boolean, timeline = false, connection?: string): Promise<BranchRead | undefined> {
    const source = JSON.stringify([scopeKey(target), connection])
    const pending = this.reads.get(source)
    if (pending) return pending
    const revision = this.get(scopeKey(target, target.sessionId, target.branchId)).revision
    const load = async (): Promise<BranchRead | undefined> => {
      const status = interactive ? await read(control<DimaStatus>('dima.status', target)) : undefined
      if (!visible()) return
      // Fetch history after status so the final idle sample includes the completed reply.
      const query = window === 'recent' ? { ...target, window } : target
      const history = timeline ? undefined : await read(control<DimaHistory>('dima.history', query))
      return { target, window, status, history, revision }
    }
    const result = load().finally(() => { this.reads.delete(source) })
    this.reads.set(source, result)
    return result
  }

  async mutate<T>(key: string, work: () => Promise<T>, sent?: Draft): Promise<T | undefined> {
    const before = this.get(key)
    if (before.pending) return
    this.set(key, { ...before, pending: true, error: undefined })
    try {
      const result = await work()
      const after = this.get(key)
      this.set(key, { revision: before.revision + 1, draft: sent === after.draft ? undefined : after.draft })
      return result
    } catch (error) {
      this.set(key, { ...this.get(key), pending: false, revision: before.revision + 1, error })
    }
  }
}

function scopeKey(source: DimaSource, ...ids: string[]): string {
  return JSON.stringify([source.target === 'local' ? null : source.targetDeviceId, ...ids])
}

function requestId(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  // LAN Web can run on HTTP, where getRandomValues is available without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function read<T>(work: Promise<T>): Promise<ReadResult<T>> {
  try { return { value: await work } } catch (error) { return { error } }
}

export function createDimaBrowser(React: ClientReact) {
  const Timeline = createDimaTimeline(React)
  const Markdown = createDimaMarkdown(React)
  const Controls = createDimaControls(React)
  const Extensions = createDimaExtensions(React)
  function useEdit(memory: DimaBrowserMemory, key: string): Edit {
    const get = () => memory.get(key)
    return React.useSyncExternalStore(memory.subscribe, get, get)
  }
  function errorView(error: unknown, t: Translate): unknown {
    return React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, messageOf(error, t))
  }
  function Transcript({ messages, truncated, lastTurnIssue, t }: DimaHistory & { t: Translate }): unknown {
    return React.createElement('div', { className: 'dshDimaTranscript' },
      messages.length === 0 ? React.createElement('p', null, t('dimaNoMessages')) : null,
      messages.map((message, index) => React.createElement('article', { key: index },
        React.createElement('strong', null, message.role === 'user' ? t('dimaUser') : 'DimAgent'),
        message.role === 'assistant' ? React.createElement(Markdown, { text: message.text }) : React.createElement('p', null, message.text))),
      truncated ? React.createElement('p', { className: 'dshRemoteHint', role: 'status' }, t('dimaTruncated')) : null,
      lastTurnIssue ? React.createElement('div', { role: 'status' },
        React.createElement('strong', null, t(lastTurnIssue.status === 'failed' ? 'dimaTurnFailed' : 'dimaTurnStopped')),
        lastTurnIssue.detail.trim() ? React.createElement('p', { style: { whiteSpace: 'pre-wrap' } }, lastTurnIssue.detail) : null) : null)
  }

  function Branch(props: {
    control: Control; source: DimaSource; sessionId: string; branchId: string; interactive: boolean; connection?: string; t: Translate
    memory: DimaBrowserMemory; refresh: { current: (() => void) | undefined }; features: DimaFeatures; operation: DimaOperationCall
    lang: DimaLanguage; onBranchChange: (result: DimaActionResult) => void
  }): unknown {
    const { control, source, sessionId, branchId, interactive, memory, refresh, t } = props
    const key = scopeKey(source, sessionId, branchId)
    const timelineReading = React.useMemo(() => memory.timelines.forBranch(scopeKey(source), key), [memory, key])
    const target = React.useMemo(() => ({ ...source, sessionId, branchId }), [source, sessionId, branchId])
    const branch = React.useMemo(() => ({ sessionId, branchId }), [sessionId, branchId])
    const [timelineActivity, setTimelineActivity] = React.useState<{ running: boolean; stopping: boolean } | undefined>(undefined)
    const readTimeline = React.useMemo(() => async (cursor?: DimaTimelineRequest['cursor']) => {
      try {
        const page = await props.operation('timeline', { ...branch, ...(cursor && { cursor }) })
        if (!cursor) setTimelineActivity(page.activity)
        return page
      } catch (error) { if (!cursor) setTimelineActivity(undefined); throw error }
    }, [branch, props.operation])
    const readImage = React.useMemo<DimaImageRead | undefined>(() => props.features.mediaRead
      ? request => props.operation('mediaRead', request) : undefined, [props.features.mediaRead, props.operation])
    const [manualRevision, setManualRevision] = React.useState(0)
    const [snapshot, setSnapshot] = React.useState<BranchView | undefined>(undefined)
    const [earlierRevision, setEarlierRevision] = React.useState<number | undefined>(undefined)
    const edit = useEdit(memory, key)
    const earlier = interactive && !edit.pending && earlierRevision === edit.revision
    const shownWindow = interactive && !earlier ? 'recent' : 'prefix'
    const history = snapshot?.[shownWindow]
    React.useEffect(() => {
      let current = true
      let reading = false
      let queued = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const refreshBranch = async (window: HistoryWindow = shownWindow): Promise<void> => {
        clearTimeout(timer)
        if (reading) {
          queued = true
          return
        }
        reading = true
        const next = await memory.readBranch(control, target, interactive, window, () => current, props.features.timeline, props.connection)
        reading = false
        if (!current) return
        if (!next || next.target !== target || next.window !== window || next.revision !== memory.get(key).revision
          || (next.status !== undefined) !== interactive) {
          queued = false
          void refreshBranch(window)
          return
        }
        setSnapshot(previous => ({ ...previous, [window]: next.history, status: next.status, revision: next.revision }))
        if (queued) {
          queued = false
          void refreshBranch()
        } else if (!document.hidden && next.status && 'value' in next.status) {
          const state = next.status.value
          // The native queue may be accepted before the branch starts running.
          const delay = state.running || state.stopping || state.approvals?.length ? 1500 : 10_000
          timer = setTimeout(() => void refreshBranch('recent'), delay)
        }
      }
      const onVisibilityChange = (): void => {
        if (document.hidden) clearTimeout(timer)
        else void refreshBranch()
      }
      if (interactive) document.addEventListener('visibilitychange', onVisibilityChange)
      refresh.current = () => { setManualRevision(n => n + 1); void refreshBranch() }
      return () => {
        current = false
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        refresh.current = undefined
      }
    }, [control, target, key, memory, refresh, interactive, shownWindow, props.features.timeline, props.connection])
    React.useEffect(() => { refresh.current?.() }, [refresh, edit.revision, target, interactive, shownWindow])

    const status = interactive && snapshot?.status && 'value' in snapshot.status ? snapshot.status.value : undefined
    const operationsReady = !edit.pending
    const legacyReady = interactive && snapshot?.revision === edit.revision && status !== undefined && operationsReady
    const activity = interactive ? status : timelineActivity
    const active = activity?.running || activity?.stopping
    const respond = (requestId: string, decision: DimaRespondRequest['decision']): void => {
      if (legacyReady) void memory.mutate(key, () => control<DimaRespondResult>('dima.respond', { ...target, requestId, decision }))
    }
    const submit = (): void => {
      const draft = memory.get(key).draft
      if (!legacyReady || status?.stopping || !draft?.text.trim()) return
      void memory.mutate(key, () => control<DimaSubmitResult>('dima.submit', { ...target, requestId: requestId(), text: draft.text }), draft)
    }
    return React.createElement(React.Fragment, null,
      !props.features.timeline && interactive && (earlier || history && 'value' in history && history.value.truncated) ? React.createElement('button', {
        type: 'button', className: 'dshDimaEntry', onClick: () => setEarlierRevision(earlier ? undefined : edit.revision),
      }, t(earlier ? 'dimaRecent' : 'dimaEarlier')) : null,
      props.features.timeline ? React.createElement(Timeline, { key: JSON.stringify([key, props.connection]), reading: timelineReading, lang: props.lang, readPage: readTimeline, readImage, revision: edit.revision + manualRevision, t }) : !history ? React.createElement('p', { role: 'status' }, t('dimaLoading'))
        : 'error' in history ? errorView(history.error, t)
        : React.createElement(Transcript, { ...history.value, lastTurnIssue: shownWindow === 'recent' ? history.value.lastTurnIssue : undefined, t }),
      interactive && snapshot?.status && 'error' in snapshot.status ? errorView(snapshot.status.error, t) : null,
      React.createElement('div', { style: { display: 'grid', gap: 8 } },
        active ? React.createElement('p', { role: 'status' }, t(activity?.stopping ? 'dimaStopping' : 'dimaRunning')) : null,
        status?.approvals?.map(approval => React.createElement('fieldset', { key: approval.requestId, style: { minWidth: 0, overflowWrap: 'anywhere' } },
          React.createElement('legend', null, t('dimaApproval', { tool: approval.tool })),
          approval.reason ? React.createElement('p', { style: { whiteSpace: 'pre-wrap' } }, approval.reason) : null,
          React.createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, approval.input),
          React.createElement('div', { className: 'dshRemotePageActions' },
            React.createElement('button', { type: 'button', className: 'dshRemotePageRefresh', disabled: !legacyReady,
              onClick: () => respond(approval.requestId, 'allow') }, t('dimaAllowOnce')),
            React.createElement('button', { type: 'button', className: 'dshRemotePageBack', disabled: !legacyReady,
              onClick: () => respond(approval.requestId, 'deny') }, t('dimaDeny'))))),
        React.createElement(Controls, { features: props.features, lang: props.lang, operation: props.operation, target: branch, t, legacyAvailable: interactive, legacyReady, operationsReady, mediaMemory: memory.media(key), connection: props.connection,
          running: activity?.running === true, stopping: activity?.stopping === true, revision: edit.revision + manualRevision, draft: edit.draft?.text ?? '', getDraft: () => memory.get(key).draft?.text ?? '',
          setDraft: (text: string) => memory.editDraft(key, text), submit, stop: () => {
            if (!legacyReady) throw new Error(t('dimaUnavailable'))
            return control<DimaHistoryRequest>('dima.interrupt', target)
          }, submitText: (text: string) => {
            if (!legacyReady) throw new Error(t('dimaUnavailable'))
            return control<DimaSubmitResult>('dima.submit', { ...target, requestId: requestId(), text })
          },
          mutate: <T,>(work: () => Promise<T>, consume = false) => memory.mutate(key, work, consume ? memory.get(key).draft : undefined),
          refresh: () => refresh.current?.(), uuid: requestId, onBranchChange: props.onBranchChange }),
        edit.error !== undefined ? errorView(edit.error, t) : null))
  }

  function NewSession(props: {
    source: DimaSource; cwd: string; control: Control; memory: DimaBrowserMemory; t: Translate; onCreated: (created: DimaCreateResult) => void
  }): unknown {
    const { source, cwd, control, memory, t } = props
    const key = scopeKey(source, cwd)
    const edit = useEdit(memory, key)
    const visible = React.useRef(false)
    React.useEffect(() => { visible.current = true; return () => { visible.current = false } }, [])
    const create = async (): Promise<void> => {
      const result = await memory.mutate(key, () => control<DimaCreateResult>('dima.create', { ...source, cwd, requestId: requestId() }))
      if (result && visible.current) props.onCreated(result)
    }
    return React.createElement(React.Fragment, null,
      React.createElement('button', { className: 'dshDimaEntry', type: 'button', onClick: () => void create(), disabled: edit.pending }, t('dimaNewSession')),
      edit.error !== undefined ? errorView(edit.error, t) : null)
  }

  return function DimaBrowser(props: {
    mainPanel?: boolean; lang?: DimaLanguage; connection?: string; source: DimaSource; sourceName: string; interactionAvailable: boolean; control: Control; memory: DimaBrowserMemory; t: Translate; onBack: () => void; onClose: () => void
  }): unknown {
    const { source, sourceName, interactionAvailable, control, memory, t } = props
    const [features, setFeatures] = React.useState<DimaFeatures>(() => dimaFeatures([]))
    const operation = React.useMemo<DimaOperationCall>(() => (key, request) => control('dima.' + key, { ...source, request }), [control, source])
    React.useEffect(() => {
      let live = true
      void control<DimaFeatures>('dima.features', source).then(f => { if (live && f && typeof f.timeline === 'boolean') setFeatures(f) }, () => {})
      return () => { live = false }
    }, [control, source])
    const [catalogRevision, setCatalogRevision] = React.useState(0)
    const [catalog, setCatalog] = React.useState<ReadResult<DimaCatalog> | undefined>(undefined)
    const [interaction, setInteraction] = React.useState<ReadResult<boolean> | undefined>(undefined)
    const hostKey = scopeKey(source)
    const [cwd, setCwd] = React.useState<string | undefined>(() => memory.navigation.get(hostKey)?.cwd)
    const [sessionId, setSessionId] = React.useState<string | undefined>(() => memory.navigation.get(hostKey)?.sessionId)
    const [selectedBranch, setSelectedBranch] = React.useState<string | undefined>(() => memory.navigation.get(hostKey)?.branchId)
    const branchRefresh = React.useRef<(() => void) | undefined>(undefined)
    React.useEffect(() => {
      let current = true
      setCatalog(undefined)
      setInteraction(undefined)
      void read(control<DimaCatalog>('dima.catalog', source)).then(result => { if (current) setCatalog(result) })
      if (interactionAvailable) void read(control<boolean>('dima.interactionProbe', source)).then(result => {
        if (!current) return
        const error = 'error' in result ? result.error : undefined
        setInteraction(error && typeof error === 'object' && 'code' in error && error.code === 'METHOD_NOT_FOUND' ? { value: false } : result)
      })
      return () => { current = false }
    }, [control, source, catalogRevision, interactionAvailable])
    const workspaces = catalog && 'value' in catalog ? catalog.value.workspaces : undefined
    const workspace = workspaces?.find(item => item.cwd === cwd)
    const session = workspace?.sessions.find(item => item.sessionId === sessionId)
    const branchId = selectedBranch !== undefined && session?.branches.includes(selectedBranch) ? selectedBranch : session?.branches[0]
    React.useEffect(() => {
      memory.navigation.set(hostKey, { cwd, sessionId, branchId: branchId ?? selectedBranch })
    }, [memory, hostKey, cwd, sessionId, branchId, selectedBranch])
    const interactive = interactionAvailable && interaction && 'value' in interaction && interaction.value === true
    const page = React.useRef<HTMLElement | null>(null)
    React.useEffect(() => { page.current?.focus() }, [cwd, sessionId])
    const title = t('dimaHistoryTitle', { source: sourceName })
    const goBack = (): void => {
      if (sessionId !== undefined) {
        setSessionId(undefined)
        setSelectedBranch(undefined)
      } else if (cwd !== undefined) setCwd(undefined)
      else props.onBack()
    }
    const openCreated = (created: DimaCreateResult): void => {
      if (!workspace || created.cwd !== workspace.cwd) return
      const item = { sessionId: created.sessionId, title: '', branches: [created.branchId] }
      setCatalog(previous => {
        if (!previous || 'error' in previous) return previous
        const workspaces = previous.value.workspaces.map(workspace => {
          if (workspace.cwd !== created.cwd || workspace.sessions.some(session => session.sessionId === item.sessionId)) return workspace
          return { ...workspace, sessions: [item, ...workspace.sessions] }
        })
        return { value: { workspaces } }
      })
      setSessionId(created.sessionId)
      setSelectedBranch(created.branchId)
    }
    const body = (): unknown => {
      if (!catalog) return React.createElement('p', { role: 'status' }, t('dimaLoading'))
      if ('error' in catalog) return errorView(catalog.error, t)
      if (!workspace) {
        if (catalog.value.workspaces.length === 0) return React.createElement('p', null, t('dimaNoWorkspaces'))
        return React.createElement('div', { className: 'dshDimaList' }, catalog.value.workspaces.map(item =>
          React.createElement('button', { key: item.cwd, type: 'button', onClick: () => { setCwd(item.cwd); setSessionId(undefined); setSelectedBranch(undefined) } }, item.cwd)))
      }
      if (!session) return React.createElement(React.Fragment, null,
        interactive ? React.createElement(NewSession, { key: workspace.cwd, source, cwd: workspace.cwd, control, memory, t, onCreated: openCreated }) : null,
        features.extensions ? React.createElement(Extensions, { key: workspace.cwd, cwd: workspace.cwd, local: source.target === 'local', operation, features, uuid: requestId, t }) : null,
        workspace.sessions.length === 0 ? React.createElement('p', null, t('dimaNoSessions'))
          : React.createElement('div', { className: 'dshDimaList' }, workspace.sessions.map(item =>
            React.createElement('button', { key: item.sessionId, type: 'button', onClick: () => { setSessionId(item.sessionId); setSelectedBranch(undefined) } }, item.title || item.sessionId))))
      if (branchId === undefined) return React.createElement('p', null, t('dimaNoBranches'))
      return React.createElement(React.Fragment, null,
        React.createElement('label', { className: 'dshDimaBranch' }, t('dimaBranch'),
          React.createElement('select', {
            value: branchId, onChange: (event: Event) => setSelectedBranch((event.target as HTMLSelectElement).value),
          }, session.branches.map(id => React.createElement('option', { key: id, value: id }, id)))),
        React.createElement(Branch, { key: JSON.stringify([session.sessionId, branchId]), control, source, sessionId: session.sessionId, branchId,
          connection: props.connection, interactive: interactive === true, refresh: branchRefresh, memory, t, operation, features, lang: props.lang ?? 'en',
          onBranchChange: (result: DimaActionResult) => {
            if (result.newSessionId) setSessionId(result.newSessionId)
            if (result.newBranchId) setSelectedBranch(result.newBranchId)
            setCatalogRevision(n => n + 1)
          } }))
    }
    return React.createElement('section', {
      className: props.mainPanel ? 'dshRemotePage dshDimaMain' : 'dshRemotePage', role: props.mainPanel ? 'region' : 'dialog', 'aria-modal': props.mainPanel ? undefined : true, 'aria-label': title, tabIndex: -1, ref: page,
    },
    React.createElement('header', { className: 'dshRemotePageHeader' },
      React.createElement('div', { className: 'dshRemotePageIntro' },
        React.createElement('strong', null, title),
        React.createElement('p', null, workspace?.cwd ?? t('dimaWorkspaces'))),
      React.createElement('div', { className: 'dshRemotePageActions' },
        React.createElement('button', { type: 'button', className: 'dshRemotePageBack', onClick: goBack }, t('dimaBack')),
        React.createElement('button', { type: 'button', className: 'dshRemotePageRefresh', disabled: !catalog,
          onClick: () => branchRefresh.current ? branchRefresh.current() : setCatalogRevision(value => value + 1),
        }, t('refreshRemoteShort')),
        React.createElement('button', { type: 'button', className: 'dshRemotePageClose', 'aria-label': t('close'), onClick: props.onClose }, '×'))),
    React.createElement('main', { className: 'dshRemotePageBody dshDimaBody' },
      workspace === undefined ? null : React.createElement('h3', null, session === undefined ? t('dimaSessions') : session.title || session.sessionId),
      interaction && 'error' in interaction ? errorView(interaction.error, t) : null,
      body()))
  }
}
