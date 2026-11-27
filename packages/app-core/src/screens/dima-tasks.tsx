import type { DimaFeatures, DimaHistoryRequest, DimaTaskRequest, DimaTaskResult } from '@dsh-remote/protocol'
import { randomUUID } from 'expo-crypto'
import { StorageAccessFramework, writeAsStringAsync } from 'expo-file-system/legacy'
import { useEffect, useRef, useState } from 'react'
import { Platform, Share, Text, TextInput, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import { strings } from '../locales/i18n'
import type { DimaClient } from '../services/dima'
import { Button, ErrorBanner } from '../ui/components'
import { useTheme } from '../ui/theme-context'

type Props = { client: DimaClient; target: DimaHistoryRequest; signal: AbortSignal; features: DimaFeatures; refresh: () => void }
export function DimaTasks(props: Props) {
  return <Panel key={JSON.stringify(props.target)} {...props} />
}
function Panel({ client, target, signal, features, refresh }: Props) {
  const { colors } = useTheme(), t = strings.dima
  const [goal, setGoal] = useState<DimaTaskResult<'goal'>['goal']>(), [items, setItems] = useState<DimaTaskResult<'tasks'>['items']>()
  const [detail, setDetail] = useState<DimaTaskResult<'taskDetail'>>(), [objective, setObjective] = useState('')
  const [confirmStop, setConfirmStop] = useState<string>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const current = () => alive.current && !signal.aborted
  async function run(work: () => Promise<void>) {
    if (lock.current || !current()) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { if (current()) setError(friendlyError(e)) }
    finally { lock.current = false; if (current()) setBusy(false) }
  }
  function button(label: string, operation: () => Promise<void>, disabled = false) {
    return <Button label={label} variant="secondary" disabled={busy || signal.aborted || disabled} onPress={() => void run(operation)} />
  }
  function line(text: string) { return <Text selectable style={{ color: colors.ink }}>{text}</Text> }
  async function loadGoal() {
    const value = await client.operation('goal', target, signal)
    if (current()) { setGoal(value.goal); setObjective(value.goal?.objective ?? '') }
  }
  async function loadTasks() {
    const value = await client.operation('tasks', target, signal)
    if (current()) { setItems(value.items); setDetail(undefined); setConfirmStop(undefined) }
  }
  async function change(action: DimaTaskRequest<'goalUpdate'>['action']) {
    const operationId = randomUUID()
    const request = action === 'set' || action === 'edit' ? { ...target, action, operationId, objective } : { ...target, action, operationId }
    const value = await client.operation('goalUpdate', request, signal)
    if (current()) { setGoal(value.goal); setObjective(value.goal?.objective ?? ''); refresh() }
  }
  async function download(format: 'json' | 'markdown') {
    const value = await client.operation('conversationExport', { sessionId: target.sessionId, branchId: 'main', format }, signal)
    if (!current()) return
    const name = 'session-' + randomUUID() + (format === 'json' ? '.json' : '.md')
    if (Platform.OS === 'android') {
      const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync()
      if (!permission.granted || !current()) return
      const uri = await StorageAccessFramework.createFileAsync(permission.directoryUri, name, format === 'json' ? 'application/json' : 'text/markdown')
      await writeAsStringAsync(uri, value.text)
    } else {
      await Share.share({ title: name, message: value.text })
    }
  }
  const activeGoal = goal?.status === 'active' || goal?.status === 'paused'
  return <View style={{ gap: 8 }}>
    {features.goal && button(t.goal, loadGoal)}
    {goal !== undefined && <View style={{ gap: 6 }}>
      {goal && line([goal.status, goal.objective, goal.reason].filter(Boolean).join(' · '))}
      {features.goalUpdate && <>
        <TextInput accessibilityLabel={t.objective} multiline maxLength={8000} value={objective} onChangeText={setObjective}
          placeholder={t.objective} placeholderTextColor={colors.muted} style={{ color: colors.ink, borderColor: colors.border, borderWidth: 1, padding: 8 }} />
        {button(activeGoal ? t.edit : t.set, () => change(activeGoal ? 'edit' : 'set'), !objective.trim() || [...objective].length > 4000)}
        {goal?.status === 'active' && button(t.pause, () => change('pause'))}
        {goal?.status === 'paused' && button(t.resume, () => change('resume'))}
        {goal && button(t.clear, () => change('clear'))}
      </>}
    </View>}
    {features.tasks && button(t.tasks, loadTasks)}
    {items?.length === 0 && line(t.tasks + ' · 0')}
    {items?.map(item => <View key={JSON.stringify(item.target)} style={{ gap: 4 }}>
      {line([item.target.branchId, item.target.kind, item.label, item.target.id, item.state].join(' · '))}
      {features.taskDetail && button(t.taskDetail, async () => { const result = await client.operation('taskDetail', { ...target, target: item.target }, signal); if (current()) setDetail(result) })}
      {features.taskStop && item.canStop && (confirmStop === JSON.stringify(item.target) ? <>
        {button(t.stop + ' · ' + item.target.id, async () => {
          setConfirmStop(undefined)
          await client.operation('taskStop', { ...target, target: item.target, operationId: randomUUID() }, signal)
          if (current()) { await loadTasks(); refresh() }
        })}
        {button(strings.common.cancel, async () => setConfirmStop(undefined))}
      </> : button(t.stop, async () => setConfirmStop(JSON.stringify(item.target))))}
      {detail && detail.target.kind === item.target.kind && detail.target.branchId === item.target.branchId && detail.target.id === item.target.id && line(detail.text + (detail.truncated ? '\n' + t.truncated : ''))}
    </View>)}
    {features.conversationExport && <>{button(t.exportMain + ' · Markdown', () => download('markdown'))}{button(t.exportMain + ' · JSON', () => download('json'))}</>}
    {!!error && <ErrorBanner message={error} />}
  </View>
}
