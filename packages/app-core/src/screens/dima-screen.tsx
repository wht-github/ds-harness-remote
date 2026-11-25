import type { DimaCatalog, DimaHistory, DimaHistoryRequest } from '@dsh-remote/protocol'
import { GitBranch, MessageSquare } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, SectionList, StyleSheet, Text, View } from 'react-native'
import { friendlyError } from '../lib/errors'
import type { AppRoute } from '../lib/navigation'
import { strings } from '../locales/i18n'
import { browseScope } from '../services/browse-memory'
import { getConnectionGeneration, requireDimaReader, useAppStore } from '../state/store'
import { BlurHeaderFrame, ErrorBanner, GroupCard, GroupRow, LoadingRows, RefreshAction, Screen, SectionTitle, TopBar } from '../ui/components'
import { spacing, type } from '../ui/theme'
import { useTheme } from '../ui/theme-context'

type OpenHistory = (request: DimaHistoryRequest, title: string) => void

export function DimaScreen({ route, onBack, onOpenHistory }: {
  route: Extract<AppRoute, { name: 'dima' }>
  onBack: () => void
  onOpenHistory: OpenHistory
}) {
  const generation = useAppStore(state => state.dimaAvailable && state.connection.phase === 'connected'
    && route.scope === browseScope(state) ? getConnectionGeneration() : undefined)
  const available = generation !== undefined
  useAppStore(state => state.language)
  const [revision, setRevision] = useState(0)
  const [response, setResponse] = useState<{
    generation: number
    request?: DimaHistoryRequest
    data?: DimaCatalog | DimaHistory
    error?: string
  }>()
  const result = response?.generation === generation && response?.request === route.history ? response : undefined
  const { colors } = useTheme()

  useEffect(() => {
    setResponse(undefined)
    if (generation === undefined) return
    const controller = new AbortController()
    const load = async () => {
      const reader = requireDimaReader(generation)
      const data = route.history === undefined
        ? await reader.catalog(controller.signal)
        : await reader.history(route.history, controller.signal)
      if (!controller.signal.aborted) setResponse({ generation, request: route.history, data })
    }
    void load().catch(error => {
      if (!controller.signal.aborted) setResponse({ generation, request: route.history, error: friendlyError(error) })
    })
    return () => controller.abort()
  }, [generation, route.history, revision])

  const refresh = () => setRevision(value => value + 1)
  const data = result?.data
  const error = available ? result?.error : strings.dima.unavailable
  const loading = available && data === undefined && error === undefined
  const history = available ? route.history : undefined
  return (
    <BlurHeaderFrame header={<TopBar
      title={history ? route.title || history.sessionId : 'DimAgent'}
      subtitle={history ? `${strings.dima.readOnly} · ${history.branchId}` : strings.dima.readOnly}
      onBack={onBack}
      action={available ? <RefreshAction refreshing={loading} onPress={refresh} /> : undefined}
    />}>
      <Screen scroll={false}>
        {error !== undefined ? <ErrorBanner message={error} onRetry={available ? refresh : undefined} />
          : data === undefined ? <LoadingRows />
          : 'workspaces' in data ? <CatalogList catalog={data} onOpenHistory={onOpenHistory} />
          : <FlatList
              data={data.messages}
              contentContainerStyle={styles.list}
              keyExtractor={(_, index) => String(index)}
              ListHeaderComponent={data.truncated ? <Text style={[type.small, { color: colors.muted }]}>{strings.dima.truncated}</Text> : null}
              ListEmptyComponent={<Text style={[type.body, { color: colors.muted }]}>{strings.dima.emptyHistory}</Text>}
              renderItem={({ item }) => <View style={styles.message}>
                <Text style={[type.smallStrong, { color: colors.muted }]}>{strings.trajectory[item.role]}</Text>
                <Text selectable style={[type.body, { color: colors.ink }]}>{item.text}</Text>
              </View>}
            />}
      </Screen>
    </BlurHeaderFrame>
  )
}

function CatalogList({ catalog, onOpenHistory }: { catalog: DimaCatalog; onOpenHistory: OpenHistory }) {
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
    renderSectionHeader={({ section }) => <SectionTitle>{section.key}</SectionTitle>}
    renderSectionFooter={({ section }) => section.data.length === 0 ? <Text style={[type.small, { color: colors.muted }]}>{strings.dima.emptySessions}</Text> : null}
    renderItem={({ item }) => {
      const title = item.title || item.sessionId
      const open = (branchId: string) => onOpenHistory({ sessionId: item.sessionId, branchId }, title)
      const [firstBranch] = item.branches
      const multiple = item.branches.length > 1
      return <GroupCard style={styles.session}>
        <GroupRow first icon={MessageSquare} label={title}
          detail={multiple ? strings.dima.chooseBranch : firstBranch ?? strings.dima.emptyBranches}
          onPress={firstBranch === undefined ? undefined : () => {
            if (multiple) setExpanded(current => current === item.sessionId ? undefined : item.sessionId)
            else open(firstBranch)
          }} />
        {multiple && expanded === item.sessionId && item.branches.map(branchId => (
          <GroupRow key={branchId} icon={GitBranch} label={branchId} onPress={() => open(branchId)} />
        ))}
      </GroupCard>
    }}
  />
}

const styles = StyleSheet.create({
  list: { padding: spacing.md },
  session: { marginBottom: spacing.xs },
  message: { gap: spacing.xxs, marginBottom: spacing.lg },
})
