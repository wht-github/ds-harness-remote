import {
  isDimaImageReference,
  mergeDimaTimelinePages,
  readDimaImage,
  type DimaImageReference,
  type DimaHistoryRequest,
  type DimaTimeline,
  type DimaTimelineTurn,
} from '@dsh-remote/protocol'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ActivityIndicator, FlatList, Modal, StyleSheet, Text, TextInput, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import { strings } from '../locales/i18n'
import { imagePreviewMetadata } from '../services/image-preview-metadata'
import type { DimaClient } from '../services/dima'
import type { ChatItem } from '../types'
import { Button, ErrorBanner, LoadingRows } from '../ui/components'
import { ChatImagePreview } from '../ui/chat-image'
import { MarkdownLinkProvider, NativeMarkdown } from '../ui/markdown'
import { spacing, type } from '../ui/theme'
import { useTheme } from '../ui/theme-context'
import { bytesToBase64 } from './chat-files'
import { ActivityExpansionMemory, ChatActivityGroup } from './chat/messages'

const noAction = async () => {}

type HistoryImage = Pick<DimaImageReference, 'sequence' | 'fileId' | 'mediaType'>

function DimaHistoryImage({
  client,
  target,
  image,
  close,
}: {
  client: DimaClient
  target: DimaHistoryRequest
  image: HistoryImage
  close: () => void
}) {
  const [uri, setUri] = useState<string>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    setError(undefined)
    setUri(undefined)
    const reference = { ...target, sequence: image.sequence, fileId: image.fileId, mediaType: image.mediaType }
    void readDimaImage(reference, request => client.operation('mediaRead', request, signal), signal)
      .then(result => {
        if (signal.aborted) return
        const metadata = imagePreviewMetadata(result.bytes)
        if (!metadata.ok || metadata.mimeType !== result.mediaType) throw new Error(strings.common.unavailable)
        // A multiple of three keeps intermediate encodings unpadded and bounds temporary allocation on Hermes.
        const chunkBytes = 48 * 1024
        const parts: string[] = []
        for (let start = 0; start < result.bytes.length; start += chunkBytes) {
          parts.push(bytesToBase64(result.bytes.subarray(start, start + chunkBytes)))
        }
        setUri('data:' + result.mediaType + ';base64,' + parts.join(''))
      })
      .catch(reason => {
        if (!signal.aborted) setError(friendlyError(reason))
      })
    return () => controller.abort()
  }, [client, target, image, attempt])
  return (
    <ChatImagePreview
      visible
      label={image.fileId}
      uri={uri}
      onClose={close}
      onError={() => {
        setUri(undefined)
        setError(strings.common.unavailable)
      }}
    >
      {error ? <ErrorBanner message={error} onRetry={() => setAttempt(n => n + 1)} /> : <ActivityIndicator color="#fff" />}
    </ChatImagePreview>
  )
}

function Turn({
  target,
  turn,
  onImage,
}: {
  target: DimaHistoryRequest
  turn: DimaTimelineTurn
  onImage?: (image: HistoryImage) => void
}) {
  const { colors } = useTheme()
  const rows: ReactElement[] = []
  let activity: ChatItem[] = []
  const flush = (closed: boolean) => {
    if (!activity.length) return
    rows.push(
      <ChatActivityGroup
        key={activity[0]!.id}
        items={activity}
        closed={closed}
        onApproval={noAction}
        onQuestion={noAction}
      />,
    )
    activity = []
  }
  for (const block of turn.blocks) {
    const base = { sessionId: target.sessionId, turn: turn.id, id: block.id, nativeSeq: block.sequence, createdAt: 0 }
    if (block.kind === 'tool') {
      const output = [block.output, block.diff].filter(value => value !== undefined).join('\n')
      activity.push({
        ...base,
        kind: 'tool',
        toolName: block.tool || block.text,
        state: block.state === 'failed' ? 'failed' : block.state === 'running' ? 'running' : 'finished',
        callDetail:
          block.input === undefined ? undefined : { text: block.input, format: 'code', truncated: block.truncated },
        resultDetail:
          block.output === undefined && block.diff === undefined
            ? undefined
            : { text: output, format: 'code', truncated: block.truncated },
      })
    } else if (block.kind === 'thinking') {
      activity.push({
        ...base,
        kind: 'message',
        role: 'assistant',
        text: '',
        reasoning: block.text,
        streamingPhase: turn.status === 'running' && block === turn.blocks.at(-1) ? 'reasoning' : undefined,
      })
    } else {
      flush(true)
      const user = block.kind === 'user'
      rows.push(
        <View key={block.id} style={user ? [styles.user, { backgroundColor: colors.grouped }] : styles.answer}>
          <Text style={[type.smallStrong, { color: colors.muted }]}>{strings.trajectory[user ? 'user' : 'assistant']}</Text>
          <NativeMarkdown text={block.text} suppressReferencedFiles />
          {block.attachments?.map(file => {
            const { mediaType, fileId } = file
            const label = mediaType + ' · ' + fileId
            const reference = { ...target, sequence: block.sequence, fileId, mediaType }
            return onImage && user && !block.live && isDimaImageReference(reference) ? (
              <Button
                key={fileId}
                label={label}
                variant="quiet"
                onPress={() => onImage(reference)}
              />
            ) : (
              <Text selectable key={file.fileId} style={[type.small, { color: colors.muted }]}>
                {label}
              </Text>
            )
          })}
          {block.truncated && <Text style={[type.small, { color: colors.muted }]}>{strings.dima.truncated}</Text>}
        </View>,
      )
    }
  }
  const usage = turn.usage?.reduce((sum, row) => sum + row.totalTokens, 0)
  const seconds =
    turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt >= turn.startedAt
      ? Math.round((turn.endedAt - turn.startedAt) / 100) / 10
      : undefined
  flush(turn.status !== 'running')
  return (
    <View style={styles.turn}>
      {rows}
      {(turn.status === 'failed' || turn.status === 'cancelled') && (
        <View>
          <Text
            accessibilityLiveRegion="polite"
            style={[type.smallStrong, { color: turn.status === 'failed' ? colors.danger : colors.muted }]}
          >
            {turn.status === 'failed' ? strings.sessionActivity.failed : strings.sessionActivity.killed}
          </Text>
          {!!turn.detail && (
            <Text selectable style={[type.body, { color: colors.ink }]}>
              {turn.detail}
            </Text>
          )}
        </View>
      )}
      {(usage !== undefined || seconds !== undefined) && (
        <Text style={[type.small, { color: colors.muted }]}>
          {[
            usage !== undefined && usage.toLocaleString() + ' tokens',
            seconds !== undefined && seconds.toLocaleString() + ' s',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )}
    </View>
  )
}

/** Scoped by Host, session and branch. Survives connection generations. */
export type DimaTimelineMemory = { snapshot?: DimaTimeline; offset: number; follow: boolean; expanded: Set<string> }

export function DimaTimelineView({
  client,
  target,
  active,
  revision,
  running,
  canReadImages,
  memory,
  onActivity,
  footer,
}: {
  client: DimaClient
  target: DimaHistoryRequest
  active: boolean
  revision: number
  running: boolean
  canReadImages: boolean
  memory: DimaTimelineMemory
  onActivity: (activity: DimaTimeline['activity']) => void
  footer?: ReactElement
}) {
  const { colors } = useTheme()
  const [timeline, setTimeline] = useState<DimaTimeline | undefined>(memory.snapshot)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const pagination = useRef<AbortController | undefined>(undefined)
  const list = useRef<FlatList<DimaTimelineTurn>>(null)
  const [image, setImage] = useState<HistoryImage & { instance: string }>()
  const showImage = active && canReadImages && !!image && image.instance === timeline?.instanceId
  useEffect(() => {
    if (!showImage) setImage(undefined)
  }, [showImage])
  const [jumpOpen, setJumpOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [atEnd, setAtEnd] = useState(memory.follow)
  const jumpTo = useRef<string | undefined>(undefined)
  const jumpAttempts = useRef(0)
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(jumpTimer.current), [])
  const restorePosition = useRef(!memory.follow && memory.offset > 0)
  useEffect(() => {
    memory.snapshot = timeline
  }, [timeline, memory])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout>
    async function readLatest() {
      let isRunning = running
      try {
        const next = await client.operation('timeline', target, signal)
        if (signal.aborted) return
        onActivity(next.activity)
        isRunning ||= next.activity?.running === true
        setTimeline(current => {
          if (!current) return next
          const merged = mergeDimaTimelinePages(current, next)
          return !memory.follow && current.instanceId === next.instanceId && merged.from > current.from ? current : merged
        })
        setError(undefined)
      } catch (e) {
        if (!signal.aborted) setError(friendlyError(e))
      }
      if (!signal.aborted) timer = setTimeout(() => void readLatest(), isRunning ? 900 : 6500)
    }
    void readLatest()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [active, client, target, revision, retry, running, onActivity, memory])
  useEffect(() => {
    setLoadingEarlier(false)
    return () => {
      pagination.current?.abort()
      pagination.current = undefined
    }
  }, [active, client, target])
  async function earlier() {
    const cursor = timeline?.earlier
    if (!active || !cursor || pagination.current) return
    memory.follow = false
    setAtEnd(false)
    const controller = new AbortController()
    pagination.current = controller
    setLoadingEarlier(true)
    try {
      const older = await client.operation('timeline', { ...target, cursor }, controller.signal)
      if (!controller.signal.aborted) setTimeline(current => (current ? mergeDimaTimelinePages(older, current) : older))
    } catch (e) {
      if (!controller.signal.aborted) setError(friendlyError(e))
    } finally {
      if (pagination.current === controller) {
        pagination.current = undefined
        setLoadingEarlier(false)
      }
    }
  }
  const jump = (turnId: string) => {
    const index = timeline?.turns.findIndex(turn => turn.id === turnId) ?? -1
    if (index < 0) return
    memory.follow = false
    setAtEnd(false)
    jumpTo.current = turnId
    jumpAttempts.current = 0
    setJumpOpen(false)
    list.current?.scrollToIndex({ index, animated: false, viewPosition: 0 })
  }
  const anchors = jumpOpen
    ? timeline?.turns
        .map(turn => ({
          id: turn.id,
          label: turn.blocks.find(block => block.kind === 'user')?.text || turn.blocks[0]?.text || turn.id,
        }))
        .filter(row => row.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : []
  return (
    <MarkdownLinkProvider canStatFiles={false}>
      <ActivityExpansionMemory.Provider value={memory.expanded}>
        {!!timeline?.turns.length && (
          <View style={styles.actions}>
            <Button
              label={strings.dima.jumpToTurn}
              variant="quiet"
              onPress={() => {
                setQuery('')
                setJumpOpen(true)
              }}
            />
            {!atEnd && (
              <Button
                label={strings.chat.jumpToLatest}
                variant="quiet"
                onPress={() => {
                  memory.follow = true
                  setAtEnd(true)
                  setRetry(n => n + 1)
                  list.current?.scrollToEnd({ animated: false })
                }}
              />
            )}
          </View>
        )}
        {showImage && (
          <DimaHistoryImage
            key={JSON.stringify([image.instance, image.sequence, image.fileId])}
            client={client}
            target={target}
            image={image}
            close={() => setImage(undefined)}
          />
        )}
        <Modal visible={jumpOpen} animationType="slide" onRequestClose={() => setJumpOpen(false)}>
          <View style={[styles.jumpSheet, { backgroundColor: colors.surface }]}>
            <Button label={strings.common.close} variant="quiet" onPress={() => setJumpOpen(false)} />
            <TextInput
              accessibilityLabel={strings.dima.jumpToTurn}
              placeholder={strings.dima.jumpToTurn}
              value={query}
              onChangeText={setQuery}
              style={[type.body, { color: colors.ink, padding: spacing.sm }]}
              placeholderTextColor={colors.muted}
            />
            <FlatList
              data={anchors}
              keyExtractor={row => row.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Button label={item.label.slice(0, 120)} variant="quiet" onPress={() => jump(item.id)} />
              )}
            />
          </View>
        </Modal>
        <FlatList
          ref={list}
          data={timeline?.turns}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })
            const id = jumpTo.current
            if (!id || ++jumpAttempts.current > 5) return
            clearTimeout(jumpTimer.current)
            jumpTimer.current = setTimeout(() => {
              const currentIndex = memory.snapshot?.turns.findIndex(turn => turn.id === id) ?? -1
              if (currentIndex >= 0) list.current?.scrollToIndex({ index: currentIndex, animated: false, viewPosition: 0 })
            }, 120)
          }}
          onScroll={({ nativeEvent: { contentSize, contentOffset, layoutMeasurement } }) => {
            if (!restorePosition.current) {
              memory.offset = contentOffset.y
              memory.follow = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
              setAtEnd(memory.follow)
            }
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (!timeline) return
            if (restorePosition.current) {
              restorePosition.current = false
              list.current?.scrollToOffset({ offset: memory.offset, animated: false })
            } else if (memory.follow) list.current?.scrollToEnd({ animated: false })
          }}
          ListHeaderComponent={
            <View>
              {error && <ErrorBanner message={error} onRetry={() => setRetry(n => n + 1)} />}
              {timeline?.earlier && (
                <Button
                  label={strings.dima.viewEarlier}
                  variant="quiet"
                  loading={loadingEarlier}
                  onPress={() => void earlier()}
                />
              )}
            </View>
          }
          ListEmptyComponent={
            timeline ? (
              <Text style={[type.body, { color: colors.muted }]}>{strings.dima.emptyHistory}</Text>
            ) : !error ? (
              <LoadingRows />
            ) : null
          }
          renderItem={({ item }) => (
            <Turn
              turn={item}
              target={target}
              onImage={
                canReadImages && active && timeline
                  ? file => setImage({ ...file, instance: timeline.instanceId })
                  : undefined
              }
            />
          )}
          ListFooterComponent={footer}
        />
      </ActivityExpansionMemory.Provider>
    </MarkdownLinkProvider>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', justifyContent: 'center' },
  jumpSheet: { flex: 1, padding: spacing.md, paddingTop: 48 },
  list: { padding: spacing.md },
  turn: { gap: spacing.sm, marginBottom: spacing.md },
  user: { alignSelf: 'flex-end', maxWidth: '94%', borderRadius: 12, padding: spacing.sm },
  answer: { gap: spacing.xxs },
})
