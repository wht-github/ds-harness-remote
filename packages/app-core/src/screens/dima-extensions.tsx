import type { DimaExtension } from '@dsh-remote/protocol'
import { randomUUID } from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import { strings } from '../locales/i18n'
import type { DimaClient } from '../services/dima'
import { Alert } from '../ui/alert'
import { Button, ErrorBanner, GroupCard, LoadingRows } from '../ui/components'
import { spacing, type } from '../ui/theme'
import { useTheme } from '../ui/theme-context'

export function DimaExtensions({
  client,
  cwd,
  signal,
  canSet,
  revision,
}: {
  client: DimaClient
  cwd: string
  signal: AbortSignal
  canSet: boolean
  revision: number
}) {
  const { colors } = useTheme()
  const [items, setItems] = useState<DimaExtension[]>()
  const [readError, setReadError] = useState<string>()
  const [writeError, setWriteError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort)
    if (signal.aborted) abort()
    return () => {
      controller.abort()
      signal.removeEventListener('abort', abort)
    }
  }, [signal, client, cwd])
  useEffect(() => {
    let current = true
    const active = lifetime.current?.signal
    if (!active || active.aborted) return
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await client.operation('extensions', { cwd }, active)
        if (current && !active.aborted) {
          setItems(result.items)
          setReadError(undefined)
        }
      } catch (error) {
        if (current && !active.aborted) {
          setItems(undefined)
          setReadError(friendlyError(error))
        }
      }
      if (current && !active.aborted) timer = setTimeout(() => void refresh(), 15_000)
    }
    void refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [client, cwd, signal, revision, reload])
  const scopeLabel = (entry: DimaExtension) =>
    entry.scope === 'host' ? strings.dima.hostScope : strings.dima.workspaceScope + ' · ' + cwd
  function confirm(item: DimaExtension) {
    const active = lifetime.current?.signal
    if (!active || active.aborted || !canSet || !item.canToggle || item.enabled === null || pending.current) return
    const label = item.enabled ? strings.dima.disable : strings.dima.enable
    Alert.alert(label + ' · ' + item.name, [item.kind + ' · ' + item.source, item.id, scopeLabel(item)].join('\n'), [
      { text: strings.common.cancel, style: 'cancel' },
      {
        text: label,
        onPress: () => {
          if (active.aborted || pending.current) return
          pending.current = true
          setBusy(true)
          setWriteError(undefined)
          void client
            .operation(
              'setExtension',
              {
                cwd,
                scope: item.scope,
                kind: item.kind,
                id: item.id,
                source: item.source,
                revision: item.revision,
                enabled: !item.enabled,
                operationId: randomUUID(),
              },
              active,
            )
            .catch(e => {
              if (!active.aborted) setWriteError(friendlyError(e) + '\n' + strings.dima.checkResult)
            })
            .finally(() => {
              if (!active.aborted) {
                pending.current = false
                setBusy(false)
                setReload(n => n + 1)
              }
            })
        },
      },
    ])
  }
  return (
    <FlatList
      data={items}
      contentContainerStyle={styles.list}
      keyExtractor={item => JSON.stringify([item.kind, item.id, item.scope, item.source])}
      ListHeaderComponent={
        <View>
          {readError && <ErrorBanner message={readError} onRetry={() => setReload(n => n + 1)} />}
          {writeError && <ErrorBanner message={writeError} onDismiss={() => setWriteError(undefined)} />}
        </View>
      }
      ListEmptyComponent={
        items ? (
          <Text style={[type.body, { color: colors.muted }]}>{strings.dima.emptyExtensions}</Text>
        ) : !readError ? (
          <LoadingRows />
        ) : null
      }
      renderItem={({ item }) => (
        <GroupCard style={styles.item}>
          <Text selectable style={[type.smallStrong, { color: colors.ink }]}>
            {item.name}
          </Text>
          <Text selectable style={[type.small, { color: colors.muted }]}>
            {item.kind} · {item.source} · {scopeLabel(item)}
          </Text>
          <Text style={[type.small, { color: colors.muted }]}>
            {item.enabled === null ? strings.common.unknown : item.enabled ? strings.dima.enabled : strings.dima.disabled}
          </Text>
          {canSet && item.canToggle && item.enabled !== null && (
            <Button
              label={item.enabled ? strings.dima.disable : strings.dima.enable}
              disabled={busy}
              variant="secondary"
              onPress={() => confirm(item)}
            />
          )}
        </GroupCard>
      )}
    />
  )
}
const styles = StyleSheet.create({
  list: { padding: spacing.md },
  item: { gap: spacing.xs, padding: spacing.sm, marginBottom: spacing.sm },
})
