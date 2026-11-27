import type {
  DimaActionRequest,
  DimaApproval,
  DimaFeatures,
  DimaHistoryRequest,
  DimaInbox,
  DimaSessionOptions,
} from '@dsh-remote/protocol'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import { strings } from '../locales/i18n'
import type { DimaClient } from '../services/dima'
import { Alert } from '../ui/alert'
import { Button, ErrorBanner, GroupCard, LoadingRows } from '../ui/components'
import { spacing, type } from '../ui/theme'
import { useTheme } from '../ui/theme-context'
import { ApprovalCard, QuestionCard } from './chat/messages'
import { DimaTasks } from './dima-tasks'

type Fields<T> = T extends unknown ? Omit<T, keyof DimaHistoryRequest | 'operationId'> : never
export type DimaActionInput = Fields<DimaActionRequest>
type Act = (action: DimaActionInput) => void

export function DimaPending({
  target,
  inbox,
  approvals,
  canAct,
  act,
  respond,
}: {
  target: DimaHistoryRequest
  inbox?: DimaInbox
  approvals?: DimaApproval[]
  canAct: boolean
  act: Act
  respond: (approval: DimaApproval, decision: 'allow' | 'deny') => void
}) {
  const { colors } = useTheme()
  return (
    <View style={styles.stack}>
      {approvals?.map(a => (
        <ApprovalCard
          key={a.requestId}
          busy={false}
          input={a.input}
          item={{
            kind: 'approval',
            id: a.requestId,
            approvalId: a.requestId,
            toolName: a.tool,
            reason: a.reason,
            sessionId: target.sessionId,
            createdAt: 0,
          }}
          onRespond={async (_, decision) => respond(a, decision === 'allowed-once' ? 'allow' : 'deny')}
        />
      ))}
      {inbox?.questions.map(q => {
        const identity = { eventId: q.eventId, requestId: q.requestId, callId: q.callId }
        return (
          <QuestionCard
            key={JSON.stringify([q.eventId, q.requestId, q.callId, q.questions])}
            item={{
              kind: 'question',
              id: q.eventId,
              sessionId: target.sessionId,
              callId: q.callId,
              createdAt: 0,
              questions: q.questions,
            }}
            busy={!canAct || !inbox.actions.includes('answer')}
            onDecline={() => act({ kind: 'answer', ...identity, declined: true })}
            onRespond={async (_, selected, custom) =>
              act({
                kind: 'answer',
                ...identity,
                answers: q.questions.map(row => ({
                  questionId: row.id,
                  selected: selected[row.id] ?? [],
                  ...(row.allowCustom && custom?.[row.id]?.trim() ? { custom: custom[row.id] } : {}),
                })),
              })
            }
          />
        )
      })}
      {!!inbox?.queue.length && (
        <GroupCard style={styles.card}>
          <Text style={[type.smallStrong, { color: colors.ink }]}>{strings.chat.queueTitle(inbox.queue.length)}</Text>
          {inbox.queue.map(item => (
            <View key={item.inputId} style={styles.stack}>
              <Text style={[type.smallStrong, { color: colors.muted }]}>
                {item.mode === 'steer' ? strings.settings.busySendSteer : strings.settings.busySendQueue}
              </Text>
              <Text selectable style={[type.body, { color: colors.ink }]}>
                {item.text}
              </Text>
              <View style={styles.row}>
                {inbox.actions.includes('steerQueued') && (
                  <Button
                    label={strings.chat.queueSteer}
                    variant="quiet"
                    disabled={!canAct || item.mode === 'steer'}
                    onPress={() => act({ kind: 'steerQueued', inputId: item.inputId })}
                  />
                )}
                {item.editable && inbox.actions.includes('retrieve') && (
                  <Button
                    label={strings.dima.retrieve}
                    variant="quiet"
                    disabled={!canAct}
                    onPress={() => act({ kind: 'retrieve', inputId: item.inputId })}
                  />
                )}
                {inbox.actions.includes('withdraw') && (
                  <Button
                    label={strings.chat.queueRemove}
                    variant="quiet"
                    disabled={!canAct}
                    onPress={() => act({ kind: 'withdraw', inputId: item.inputId })}
                  />
                )}
              </View>
            </View>
          ))}
        </GroupCard>
      )}
    </View>
  )
}

export function DimaSessionPanel({
  client,
  target,
  features,
  signal,
  inbox,
  busy,
  revision,
  refresh,
  act,
}: {
  client: DimaClient
  target: DimaHistoryRequest
  features: DimaFeatures
  signal: AbortSignal
  inbox?: DimaInbox
  busy: boolean
  revision: number
  refresh: () => void
  act: Act
}) {
  const { colors } = useTheme()
  const [options, setOptions] = useState<DimaSessionOptions>()
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  useEffect(() => {
    if (!features.options || signal.aborted) return
    const controller = new AbortController()
    const retire = () => controller.abort()
    signal.addEventListener('abort', retire)
    void client
      .operation('options', target, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setOptions(value)
          setError(undefined)
        }
      })
      .catch(e => {
        if (!controller.signal.aborted) {
          setOptions(undefined)
          setError(friendlyError(e))
        }
      })
    return () => {
      signal.removeEventListener('abort', retire)
      controller.abort()
    }
  }, [client, features, target, signal, revision])
  const enabled = (kind: DimaActionInput['kind']) => features.act && inbox?.actions.includes(kind)
  const confirm = (label: string, action: DimaActionInput) =>
    Alert.alert(label, target.sessionId + ' · ' + target.branchId, [
      { text: strings.common.cancel, style: 'cancel' },
      {
        text: label,
        onPress: () => {
          if (!signal.aborted) act(action)
        },
      },
    ])
  const model = options?.model
  const efforts =
    options?.models?.find(row => row.modelId === model?.modelId && row.provider === model?.provider)?.efforts ?? []
  return (
    <View style={styles.stack}>
      {error && <ErrorBanner message={error} onRetry={refresh} />}
      {features.options && !options && !error && <LoadingRows />}
      {model && (
        <Text selectable style={[type.body, { color: colors.ink }]}>
          {strings.mention.model} · {model.provider} / {model.modelId}
          {options?.effort ? ' · ' + options.effort : ''}
        </Text>
      )}
      {options?.usage && (
        <Text selectable style={[type.small, { color: colors.muted }]}>
          {strings.messageActions.usage} · {options.usage.estimatedInputTokens} / {options.usage.contextWindow}
        </Text>
      )}
      {enabled('setModel') &&
        options?.models?.map(row => (
          <Button
            key={JSON.stringify([row.provider, row.modelId])}
            label={row.label || row.modelId}
            variant="secondary"
            disabled={busy || (model?.provider === row.provider && model.modelId === row.modelId)}
            onPress={() => act({ kind: 'setModel', provider: row.provider, modelId: row.modelId })}
          />
        ))}
      {!!enabled('setEffort') && (
        <View style={styles.row}>
          {efforts.map(e => (
            <Button
              key={e}
              label={e}
              variant="quiet"
              disabled={busy || e === options?.effort}
              onPress={() => act({ kind: 'setEffort', effort: e })}
            />
          ))}
        </View>
      )}
      {enabled('setAgent') &&
        options?.agents?.map(agent => (
          <Button
            key={agent.agentId}
            label={agent.label || agent.agentId}
            variant="secondary"
            disabled={busy}
            onPress={() =>
              confirm(strings.dima.setAgent + ' · ' + (agent.label || agent.agentId), {
                kind: 'setAgent',
                agentId: agent.agentId,
              })
            }
          />
        ))}
      {enabled('rename') && (
        <View style={styles.stack}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={strings.dima.sessionTitle}
            accessibilityLabel={strings.dima.sessionTitle}
            style={[styles.input, { color: colors.ink, borderColor: colors.separator }]}
            placeholderTextColor={colors.muted}
          />
          <Button
            label={strings.dima.sessionTitle}
            variant="secondary"
            disabled={busy}
            onPress={() => confirm(strings.dima.sessionTitle, { kind: 'rename', title: title.trim() || null })}
          />
        </View>
      )}
      {enabled('branchCreate') && (
        <View style={styles.stack}>
          <TextInput
            value={prompt}
            multiline
            onChangeText={setPrompt}
            placeholder={strings.dima.branchPrompt}
            placeholderTextColor={colors.muted}
            accessibilityLabel={strings.dima.branchPrompt}
            style={[styles.input, { color: colors.ink, borderColor: colors.separator }]}
          />
          <Button
            label={strings.dima.createBranch}
            variant="secondary"
            disabled={busy || !prompt.trim()}
            onPress={() => act({ kind: 'branchCreate', text: prompt })}
          />
        </View>
      )}
      <View style={styles.row}>
        {enabled('fork') && (
          <Button
            label={strings.dima.fork}
            variant="secondary"
            disabled={busy}
            onPress={() => confirm(strings.dima.fork, { kind: 'fork' })}
          />
        )}
        {enabled('compact') && (
          <Button
            label={strings.mention.compact}
            variant="secondary"
            disabled={busy}
            onPress={() => confirm(strings.mention.compact, { kind: 'compact' })}
          />
        )}
        {enabled('setDefault') && (
          <Button
            label={strings.dima.defaultBranch}
            variant="quiet"
            disabled={busy}
            onPress={() => confirm(strings.dima.defaultBranch, { kind: 'setDefault' })}
          />
        )}
        {enabled('endBranch') && (
          <Button
            label={strings.dima.endBranch}
            variant="quiet"
            disabled={busy}
            onPress={() => confirm(strings.dima.endBranch, { kind: 'endBranch' })}
          />
        )}
      </View>
      <DimaTasks client={client} target={target} signal={signal} features={features} refresh={refresh} />
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  card: { padding: spacing.sm, gap: spacing.sm },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.sm },
})
