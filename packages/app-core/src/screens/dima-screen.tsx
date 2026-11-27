import {
  dimaFeatures, type DimaFeatures, type DimaInbox, type DimaMediaReference, DIMA_MAX_PROMPT_CHARS, type DimaApproval, type DimaCatalog, type DimaHistory, type DimaHistoryRequest, type DimaStatus,
} from '@dsh-remote/protocol'
import { randomUUID } from 'expo-crypto'
import { ArrowUp, GitBranch, MessageSquare, Plus, Square } from 'lucide-react-native'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, FlatList, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import type { AppRoute } from '../lib/navigation'
import { strings } from '../locales/i18n'
import { stopWithDimaDraft } from '../services/dima'
import { browseScope } from '../services/browse-memory'
import { connectionDimaClient, getConnectionGeneration, useAppStore } from '../state/store'
import { BlurHeaderFrame, Button, ErrorBanner, GroupCard, GroupRow, IconButton, LoadingRows, RefreshAction, TopBar } from '../ui/components'
import { KeyboardInset } from '../ui/keyboard-inset'
import { radius, spacing, type } from '../ui/theme'
import { useTheme } from '../ui/theme-context'
import { NativeMarkdown, MarkdownLinkProvider } from '../ui/markdown'
import { DimaTimelineView, type DimaTimelineMemory } from './dima-timeline'
import { DimaPending, DimaSessionPanel, type DimaActionInput } from './dima-controls'
import { DimaExtensions } from './dima-extensions'
import { DimaMedia, type DimaMediaMemory } from './dima-media'

const legacyFeatures = dimaFeatures([])

type OpenHistory = (request: DimaHistoryRequest, title: string) => void
type DimaRoute = Extract<AppRoute, { name: 'dima' }>
type ScreenProps = { active: boolean; route: DimaRoute; onBack: () => void; onOpenHistory: OpenHistory }
type Client = ReturnType<typeof connectionDimaClient>

function watchAppState(notify: () => void) {
  const subscription = AppState.addEventListener('change', notify)
  return () => subscription.remove()
}

export function DimaScreen(props: ScreenProps) {
  const foreground = useSyncExternalStore(watchAppState, () => AppState.currentState === 'active')
  const { scope } = props.route
  const sameHost = useAppStore(state => scope === browseScope(state))
  const generation = useAppStore(state => scope === browseScope(state) && state.dimaAvailable && state.connection.phase === 'connected'
    ? getConnectionGeneration() : undefined)
  const interactive = useAppStore(state => state.dimaChatAvailable) && generation !== undefined
  const features = useAppStore(state => state.dimaFeatures) ?? legacyFeatures
  useAppStore(state => state.language)
  const client = useMemo(() => generation === undefined ? undefined : connectionDimaClient(scope, generation), [scope, generation])
  const [memory] = useState<DimaTimelineMemory>(() => ({ offset: 0, follow: true, expanded: new Set() }))
  const mediaMemory = useRef<DimaMediaMemory>({ items: [] }).current
  const [draft, setDraft] = useState('')
  const [wasInteractive, setWasInteractive] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  useEffect(() => {
    if (generation !== undefined) setWasInteractive(interactive)
  }, [generation, interactive])

  return <DimaPage key={String(generation) + '/' + interactive} {...props} active={props.active && foreground}
    unconfirmed={unconfirmed} setUnconfirmed={setUnconfirmed} client={client} features={features} memory={memory} mediaMemory={mediaMemory} interactive={interactive}
    showComposer={interactive || (sameHost && generation === undefined && wasInteractive)} draft={draft} setDraft={setDraft} />
}

function DimaPage({ active, route, onBack, onOpenHistory, client, features, memory, mediaMemory, interactive, showComposer, draft, setDraft, unconfirmed, setUnconfirmed }: ScreenProps & {
  client?: Client; features: DimaFeatures; memory: DimaTimelineMemory; mediaMemory: DimaMediaMemory; interactive: boolean; showComposer: boolean; draft: string; setDraft: (text: string) => void
  unconfirmed: boolean; setUnconfirmed: (value: boolean) => void
}) {
  const { colors } = useTheme()
  const target = route.history
  const [catalog, setCatalog] = useState<DimaCatalog>()
  const [recentHistory, setRecentHistory] = useState<DimaHistory>()
  const [earlierHistory, setEarlierHistory] = useState<DimaHistory>()
  const [showEarlier, setShowEarlier] = useState(false)
  const [status, setStatus] = useState<DimaStatus>()
  const [nativeActivity, setNativeActivity] = useState<{ running: boolean; stopping: boolean }>()
  const [inbox, setInbox] = useState<DimaInbox>()
  const [inboxError, setInboxError] = useState<string>()
  const [controlsOpen, setControlsOpen] = useState(false)
  const [confirmedTitle, setConfirmedTitle] = useState<string | null>()
  const [extensionCwd, setExtensionCwd] = useState<string>()
  const [scopeSignal, setScopeSignal] = useState<AbortSignal>()
  // Android's system photo picker can temporarily background the app.
  const [mediaSignal, setMediaSignal] = useState<AbortSignal>()
  const [readingMedia, setReadingMedia] = useState(false)
  useLayoutEffect(() => {
    const controller = new AbortController()
    setMediaSignal(controller.signal)
    return () => controller.abort()
  }, [])
  const prepareMedia = useRef<(() => Promise<DimaMediaReference[]>) | null>(null)
  const [hasParts, setHasParts] = useState(false)
  const [mediaKey, setMediaKey] = useState(0)
  const onPrepare = useCallback((prepare: (() => Promise<DimaMediaReference[]>) | null) => {
    prepareMedia.current = prepare
    setHasParts(prepare !== null)
  }, [])
  const [readError, setReadError] = useState<string>()
  const [operationError, setOperationError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const page = useRef<AbortController | undefined>(undefined)

  useLayoutEffect(() => {
    if (!active || !client) return
    const controller = new AbortController()
    page.current = controller
    setScopeSignal(controller.signal)
    pending.current = false
    setBusy(false)
    setStatus(undefined)
    return () => { controller.abort(); page.current = undefined }
  }, [active, client, interactive, target])

  useEffect(() => {
    if (!active || !client || busy) return
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    setReadError(undefined)
    const fail = (error: unknown) => {
      if (!signal.aborted) {
        setStatus(undefined)
        setReadError(friendlyError(error))
      }
      return undefined
    }
    let failures = 0
    const observe = async (branch: DimaHistoryRequest, initial: boolean) => {
      let delay = 10_000
      try {
        const next = interactive ? await client.status(branch, signal) : undefined
        if (signal.aborted) return
        setStatus(next)
        // Status precedes history so the first idle sample includes the final reply.
        if (!features.timeline && (!showEarlier || initial)) {
          const query = interactive && !showEarlier ? { ...branch, window: 'recent' as const } : branch
          const history = await client.history(query, signal)
          if (signal.aborted) return
          if (showEarlier) setEarlierHistory(history)
          else setRecentHistory(history)
        }
        failures = 0
        setReadError(undefined)
        if (next?.running || next?.stopping || next?.approvals?.length) delay = 1500
      } catch (error) {
        fail(error)
        delay = Math.min(30_000, 1500 * 2 ** Math.min(++failures, 5))
      }
      if (interactive && !signal.aborted) timer = setTimeout(() => void observe(branch, false), delay)
    }
    if (target) void observe(target, true)
    else void client.catalog(signal).then(result => { if (!signal.aborted) setCatalog(result) }).catch(fail)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, client, busy, revision, interactive, target, showEarlier, features.timeline])

  useEffect(() => {
    if (!active || !client || !target || !features.inbox || busy) { setInbox(undefined); return }
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout>
    async function readInbox(service: Client, branch: DimaHistoryRequest) {
      let fast = false
      try {
        const next = await service.operation('inbox', branch, signal)
        if (signal.aborted) return
        setInbox(next); setInboxError(undefined)
        fast = next.questions.length > 0 || next.queue.length > 0
      } catch (e) { if (!signal.aborted) { setInbox(undefined); setInboxError(friendlyError(e)) } }
      if (!signal.aborted) timer = setTimeout(() => void readInbox(service, branch), fast || status?.running ? 1400 : 6000)
    }
    void readInbox(client, target)
    return () => {controller.abort(); clearTimeout(timer)}
  }, [active, client, target, busy, revision, features.inbox, status?.running])

  const refresh = () => { setStatus(undefined); setRevision(value => value + 1) }
  async function mutate(operation: (client: Client, signal: AbortSignal) => Promise<void>, allowed = interactive) {
    const signal = page.current?.signal
    if (!client || !allowed || !signal || signal.aborted || pending.current) return
    pending.current = true
    setUnconfirmed(true)
    setShowEarlier(false)
    setBusy(true)
    setStatus(undefined)
    setOperationError(undefined)
    try {
      await operation(client, signal)
      if (!signal.aborted) setUnconfirmed(false)
    } catch (error) {
      if (!signal.aborted) setOperationError(friendlyError(error) + '\n' + strings.dima.checkResult)
    } finally {
      if (!signal.aborted) {
        pending.current = false
        setBusy(false)
        refresh()
      }
    }
  }
  const create = (cwd: string) => void mutate(async (service, signal) => {
    const { sessionId, branchId } = await service.create({ cwd, requestId: randomUUID() }, signal)
    if (!signal.aborted) onOpenHistory({ sessionId, branchId }, strings.sessions.untitled)
  })
  const activity = status ?? nativeActivity
  const running = activity?.running || activity?.stopping
  const stopping = activity?.stopping === true
  const mediaAvailable = features.mediaSubmit && !!inbox?.media && Object.values(inbox.media).some(Boolean)
  const canQueue = hasParts ? mediaAvailable : interactive && status !== undefined
  const steer = features.act && inbox?.actions.includes('steer') === true
  const compose = showComposer || steer || mediaAvailable || hasParts
  const tooLong = draft.length > DIMA_MAX_PROMPT_CHARS
  const canSubmit = active && !!client && !busy && !readingMedia && !stopping
    && (running || !status?.approvals?.length) && (!!draft.trim() || hasParts) && !tooLong
  const submit = (mode: 'queue' | 'steer') => {
    if (!target || !canSubmit || (mode === 'steer' ? !steer : !canQueue)) return
    void mutate(async (service, signal) => {
      if (hasParts) {
        const prepare = prepareMedia.current
        if (!features.mediaSubmit || !prepare) throw new Error(strings.dima.unavailable)
        const refs = await prepare()
        if (!refs.length || signal.aborted) throw new Error(strings.dima.unavailable)
        await service.operation('mediaSubmit', { ...target, requestId: randomUUID(), mode,
          parts: [...(draft.trim() ? [{type:'text' as const,text:draft}] : []), ...refs] }, signal)
      } else if (mode === 'steer') {
        await service.operation('act', { ...target, kind:'steer', text:draft, operationId: randomUUID() }, signal)
      } else await service.submit({ ...target, text: draft, requestId: randomUUID() }, signal)
      if (!signal.aborted) {
        mediaMemory.items = []
        setDraft('')
        setMediaKey(n => n+1)
      }
    }, mode === 'steer' ? steer : canQueue)
  }
  const act = (input: DimaActionInput) => {
    if (!target || !features.act || !inbox?.actions.includes(input.kind)) return
    void mutate(async (service, signal) => {
      const result = await service.operation('act', { ...target, ...input, operationId:randomUUID() }, signal)
      if (signal.aborted) return
      if (input.kind === 'rename') {
        setConfirmedTitle(input.title)
        if (input.title === null) {
          const result = await service.catalog(signal).catch(() => undefined)
          const session = result?.workspaces.flatMap(row => row.sessions).find(row => row.sessionId === target.sessionId)
          if (session && !signal.aborted) setConfirmedTitle(session.title ?? null)
        }
      }
      if (result.restoredText !== undefined) setDraft([draft,result.restoredText].filter(Boolean).join('\n'))
      if (result.newBranchId) onOpenHistory({sessionId:result.newSessionId ?? target.sessionId,branchId:result.newBranchId},route.title || strings.sessions.untitled)
    }, features.act)
  }
  const recoverQueue = features.inbox && features.act && inbox?.actions.includes('retrieve') === true
  const interrupt = (send: boolean) => {
    if (!interactive || !target || !status?.running || status.stopping || (send && !recoverQueue)) return
    if (recoverQueue && (hasParts || readingMedia)) { setOperationError(strings.dima.queueNotRecoverable); return }
    void mutate(async (service, signal) => {
      if (recoverQueue) await stopWithDimaDraft(service, target, draft, send, signal, randomUUID, setDraft)
      else await service.interrupt(target, signal)
    })
  }
  const respond = (approval: DimaApproval, decision: 'allow' | 'deny') => {
    if (target && status?.approvals?.includes(approval)) void mutate(async (service, signal) => {
      await service.respond({ ...target, requestId: approval.requestId, decision }, signal)
    })
  }
  const availableTarget = client ? target : undefined
  const canAccessSession = interactive || features.act || features.mediaSubmit || features.goalUpdate || features.taskStop
  const subtitle = availableTarget ? (canAccessSession ? availableTarget.branchId : strings.dima.readOnly + ' · ' + availableTarget.branchId)
    : client ? (interactive ? strings.sessions.workspaces : strings.dima.readOnly) : undefined
  const history = showEarlier ? earlierHistory : recentHistory
  const data = target ? (features.timeline ? status ?? target : history) : catalog
  const error = client ? readError : strings.dima.unavailable
  const sameSessionCanWarn = showComposer || features.act || features.mediaSubmit
  const canManageSession = features.options || features.act || features.tasks || features.goal || features.conversationExport
  return <BlurHeaderFrame inset header={<TopBar
    title={extensionCwd ? strings.dima.extensions : availableTarget ? (confirmedTitle === undefined ? route.title : confirmedTitle) || availableTarget.sessionId : 'DimAgent'} subtitle={extensionCwd ?? subtitle} onBack={extensionCwd ? () => setExtensionCwd(undefined) : controlsOpen ? () => setControlsOpen(false) : onBack}
    action={client ? <RefreshAction refreshing={busy || (!data && !error)} onPress={refresh} /> : undefined}
  />}>
    <KeyboardInset>
      {error && <ErrorBanner message={error} onRetry={client && !busy ? refresh : undefined} />}
      {!busy && (operationError || (sameSessionCanWarn && unconfirmed)) && <ErrorBanner message={operationError ?? strings.dima.checkResult}
        onDismiss={() => { setOperationError(undefined); setUnconfirmed(false) }} />}
      {inboxError && <ErrorBanner message={inboxError} onRetry={refresh} />}
      {!features.timeline && interactive && target && (recentHistory?.truncated || showEarlier) && <Button variant="quiet" disabled={busy}
        label={showEarlier ? strings.dima.backToRecent : strings.dima.viewEarlier} onPress={() => { setStatus(undefined); setShowEarlier(!showEarlier) }} />}
      {target && canManageSession && <Button label={controlsOpen ? strings.common.close : strings.dima.sessionControls} variant="quiet" onPress={()=>setControlsOpen(!controlsOpen)} />}
      {extensionCwd && features.extensions && client && scopeSignal && active ? <DimaExtensions key={extensionCwd} client={client} cwd={extensionCwd} signal={scopeSignal} canSet={features.setExtension} revision={revision} />
        : controlsOpen && target && client && scopeSignal && active ? <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled"><DimaSessionPanel client={client} target={target} signal={scopeSignal} features={features} revision={revision} refresh={refresh} inbox={inbox} busy={busy} act={act} /></ScrollView>
        : target && features.timeline && client ? <DimaTimelineView client={client} target={target} canReadImages={features.mediaRead} active={active} revision={revision} running={!!running} memory={memory} onActivity={setNativeActivity} />
        : target ? <BranchHistory key={showEarlier ? 'earlier' : 'recent'} history={history} followEnd={!showEarlier} turnIssue={interactive && !showEarlier ? history?.lastTurnIssue : undefined} loading={!!client && !history && !error} />
        : catalog ? <CatalogList catalog={catalog} onOpenHistory={onOpenHistory} onExtensions={features.extensions ? setExtensionCwd : undefined}
          onCreate={interactive ? create : undefined} busy={busy} /> : !error && <LoadingRows />}
      {target && !controlsOpen && active && (interactive || features.inbox) && ((status?.approvals?.length ?? 0) + (inbox?.questions.length ?? 0) + (inbox?.queue.length ?? 0) > 0) && <ScrollView keyboardShouldPersistTaps="handled" style={styles.pending}>
        <DimaPending target={target} approvals={busy ? undefined : status?.approvals} inbox={inbox} canAct={features.act && !busy} act={act} respond={respond} /></ScrollView>}
      {target && (showComposer || features.act || features.mediaSubmit) && <View style={[styles.composer, (controlsOpen || !compose) && styles.hidden, { borderColor: colors.separator, backgroundColor: colors.surface }]}>
        {client && mediaSignal && features.mediaSubmit && <DimaMedia client={client} target={target} memory={mediaMemory} features={features} available={inbox?.media} signal={mediaSignal} disabled={busy || !active} onPrepare={onPrepare} onReading={setReadingMedia} resetKey={mediaKey} />}
        {running && <View style={styles.statusRow}>
          <Text accessibilityLiveRegion="polite" style={[type.smallStrong, styles.flex, { color: colors.muted }]}>
            {stopping ? strings.chat.stopping : strings.status.running}
          </Text>
          {interactive && status?.running && <Button label={recoverQueue ? strings.dima.stopBranch : strings.dima.stopOnly} icon={Square} variant="secondary" disabled={busy || stopping || !!readError} onPress={()=>interrupt(false)} />}
          {interactive && status?.running && recoverQueue && <Button label={strings.dima.stopSend} variant="secondary" disabled={busy || status?.stopping || (!draft.trim() && !inbox?.queue.length)} onPress={()=>interrupt(true)} />}
        </View>}
        {tooLong && <Text style={[type.small, { color: colors.danger }]}>{strings.chat.draftTooLong(DIMA_MAX_PROMPT_CHARS)}</Text>}
        <View style={styles.inputRow}>
          <TextInput multiline accessibilityLabel={strings.chat.placeholder} placeholder={strings.chat.placeholder}
            value={draft} editable={active && !busy} onChangeText={setDraft} placeholderTextColor={colors.muted}
            style={[type.body, styles.input, { backgroundColor: colors.grouped, color: colors.ink }]} />
          {running && canQueue && <Button label={strings.settings.busySendQueue} disabled={!canSubmit} variant={steer ? 'quiet' : 'secondary'} onPress={() => submit('queue')} />}
          {steer && (running || !interactive) && <Button label={strings.settings.busySendSteer} disabled={!canSubmit} onPress={() => submit('steer')} />}
          {!running && (canQueue || interactive) && <IconButton label={strings.chat.send} icon={ArrowUp} filled disabled={!canSubmit || !canQueue} onPress={() => submit('queue')} />}
        </View>
      </View>}
    </KeyboardInset>
  </BlurHeaderFrame>
}

function BranchHistory({ history, loading, followEnd, turnIssue }: {
  turnIssue?: DimaHistory['lastTurnIssue']
  history?: DimaHistory; loading: boolean; followEnd: boolean
}) {
  const { colors } = useTheme()
  const list = useRef<FlatList<DimaHistory['messages'][number]>>(null)
  const atEnd = useRef(true)
  return <FlatList ref={list} data={history?.messages} keyExtractor={(_, index) => String(index)} contentContainerStyle={styles.list}
    keyboardShouldPersistTaps="handled" onContentSizeChange={() => { if (followEnd && atEnd.current) list.current?.scrollToEnd({ animated: false }) }}
    onScroll={({ nativeEvent: { contentSize, contentOffset, layoutMeasurement } }) => {
      atEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
    }} scrollEventThrottle={100}
    ListHeaderComponent={history?.truncated ? <Text style={[type.small, { color: colors.muted }]}>{strings.dima.truncated}</Text> : null}
    ListEmptyComponent={loading ? <LoadingRows /> : history && !turnIssue ? <Text style={[type.body, { color: colors.muted }]}>{strings.dima.emptyHistory}</Text> : null}
    renderItem={({ item }) => <View style={styles.message}>
      <Text style={[type.smallStrong, { color: colors.muted }]}>{strings.trajectory[item.role]}</Text>
      <MarkdownLinkProvider canStatFiles={false}><NativeMarkdown text={item.text} suppressReferencedFiles /></MarkdownLinkProvider>
    </View>}
    ListFooterComponent={<View>
      {turnIssue && <View style={styles.message}>
        <Text accessibilityLiveRegion="polite" style={[type.smallStrong, { color: turnIssue.status === 'failed' ? colors.danger : colors.muted }]}>
          {turnIssue.status === 'failed' ? strings.sessionActivity.failed : strings.sessionActivity.killed}
        </Text>
        {!!turnIssue.detail.trim() && <Text selectable style={[type.body, { color: colors.ink }]}>{turnIssue.detail}</Text>}
      </View>}
    </View>}
  />
}

function CatalogList({ catalog, onOpenHistory, onCreate, onExtensions, busy }: {
  catalog: DimaCatalog; onOpenHistory: OpenHistory; onCreate?: (cwd: string) => void; onExtensions?: (cwd: string) => void; busy: boolean
}) {
  const { colors } = useTheme()
  const [expanded, setExpanded] = useState<string>()
  const sections = useMemo(() => catalog.workspaces.map(workspace => ({ key: workspace.cwd, data: workspace.sessions })), [catalog])
  return <SectionList
    sections={sections}
    extraData={expanded}
    keyExtractor={item => item.sessionId}
    contentContainerStyle={styles.list}
    stickySectionHeadersEnabled={false}
    ListEmptyComponent={<Text style={[type.body, { color: colors.muted }]}>{strings.workspaces.emptyTitle}</Text>}
    renderSectionHeader={({ section }) => <View style={styles.workspaceHeader}>
      <Text selectable accessibilityRole="header" style={[type.smallStrong, styles.flex, { color: colors.muted }]}>{section.key}</Text>
      {onExtensions && <Button label={strings.dima.extensions} variant="quiet" disabled={busy} onPress={() => onExtensions(section.key)} />}
      {onCreate && <IconButton icon={Plus} label={strings.workspaces.newSessionIn(section.key)} disabled={busy} onPress={() => onCreate(section.key)} />}
    </View>}
    renderSectionFooter={({ section }) => section.data.length === 0 ? <Text style={[type.small, { color: colors.muted }]}>{strings.dima.emptySessions}</Text> : null}
    renderItem={({ item }) => {
      const title = item.title || item.sessionId
      const open = (branchId: string) => onOpenHistory({ sessionId: item.sessionId, branchId }, title)
      const [firstBranch] = item.branches
      const multiple = item.branches.length > 1
      return <GroupCard style={styles.session}>
        <GroupRow first icon={MessageSquare} label={title}
          detail={multiple ? strings.dima.chooseBranch : firstBranch ?? strings.dima.emptyBranches}
          onPress={busy || firstBranch === undefined ? undefined : () => {
            if (multiple) setExpanded(current => current === item.sessionId ? undefined : item.sessionId)
            else open(firstBranch)
          }} />
        {multiple && expanded === item.sessionId && item.branches.map(branchId => (
          <GroupRow key={branchId} icon={GitBranch} label={branchId} onPress={busy ? undefined : () => open(branchId)} />
        ))}
      </GroupCard>
    }}
  />
}

const styles = StyleSheet.create({
  hidden: { display: 'none' }, flex: { flex: 1 }, pending: { flexGrow: 0, maxHeight: '42%', paddingHorizontal: spacing.md },
  workspaceHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  list: { padding: spacing.md },
  session: { marginBottom: spacing.xs },
  message: { gap: spacing.xxs, marginBottom: spacing.lg },
  approval: { gap: spacing.xs, marginBottom: spacing.md, padding: spacing.md },
  composer: { gap: spacing.xxs, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
  input: { flex: 1, maxHeight: 140, minHeight: 44, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
})
