import type { DimaCatalog, DimaHistory } from '@dsh-remote/protocol'
import type { Translate } from '../client-locale.js'
import { messageOf } from './presentation.js'
import type { ClientReact } from './types.js'

export type DimaSource = { target: 'local' } | { target: 'remote'; targetDeviceId: string }
type Control = <T>(endpoint: string, payload: unknown) => Promise<T>
type ReadResult<T> = { value: T } | { error: unknown }

export function createDimaBrowser(React: ClientReact) {
  function useRead<T>(control: Control, endpoint: string, payload: unknown, revision: number) {
    const [result, setResult] = React.useState<ReadResult<T> | undefined>(undefined)
    React.useEffect(() => {
      let current = true
      setResult(undefined)
      void control<T>(endpoint, payload).then(value => {
        if (current) setResult({ value })
      }, error => {
        if (current) setResult({ error })
      })
      return () => { current = false }
    }, [control, endpoint, payload, revision])
    return result
  }

  function Transcript(props: {
    control: Control; source: DimaSource; sessionId: string; branchId: string; revision: number; t: Translate
  }): unknown {
    const { control, source, sessionId, branchId, revision, t } = props
    const request = React.useMemo(() => ({ ...source, sessionId, branchId }), [source, sessionId, branchId])
    const result = useRead<DimaHistory>(control, 'dima.history', request, revision)
    if (!result) return React.createElement('p', { role: 'status' }, t('dimaLoading'))
    if ('error' in result) return React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, messageOf(result.error, t))
    const { messages, truncated } = result.value
    return React.createElement('div', { className: 'dshDimaTranscript' },
      messages.length === 0 ? React.createElement('p', null, t('dimaNoMessages')) : null,
      messages.map((message, index) => React.createElement('article', { key: index },
        React.createElement('strong', null, message.role === 'user' ? t('dimaUser') : 'DimAgent'),
        React.createElement('p', null, message.text))),
      truncated ? React.createElement('p', { className: 'dshRemoteHint', role: 'status' }, t('dimaTruncated')) : null)
  }

  return function DimaBrowser(props: {
    source: DimaSource; sourceName: string; control: Control; t: Translate; onBack: () => void; onClose: () => void
  }): unknown {
    const { source, sourceName, control, t } = props
    const [catalogRevision, setCatalogRevision] = React.useState(0)
    const [historyRevision, setHistoryRevision] = React.useState(0)
    const [cwd, setCwd] = React.useState<string | undefined>(undefined)
    const [sessionId, setSessionId] = React.useState<string | undefined>(undefined)
    const [selectedBranch, setSelectedBranch] = React.useState<string | undefined>(undefined)
    const catalog = useRead<DimaCatalog>(control, 'dima.catalog', source, catalogRevision)
    const workspaces = catalog && 'value' in catalog ? catalog.value.workspaces : undefined
    const workspace = workspaces?.find(item => item.cwd === cwd)
    const session = workspace?.sessions.find(item => item.sessionId === sessionId)
    const branchId = selectedBranch !== undefined && session?.branches.includes(selectedBranch)
      ? selectedBranch : session?.branches[0]
    const page = React.useRef<HTMLElement | null>(null)
    React.useEffect(() => { page.current?.focus() }, [cwd, sessionId])
    const title = t('dimaHistoryTitle', { source: sourceName })
    const goBack = (): void => {
      if (session !== undefined) {
        setSessionId(undefined)
        setSelectedBranch(undefined)
      } else if (workspace !== undefined) {
        setCwd(undefined)
        setSessionId(undefined)
      } else props.onBack()
    }
    const body = (): unknown => {
      if (!catalog) return React.createElement('p', { role: 'status' }, t('dimaLoading'))
      if ('error' in catalog) return React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, messageOf(catalog.error, t))
      if (!workspace) {
        if (catalog.value.workspaces.length === 0) return React.createElement('p', null, t('dimaNoWorkspaces'))
        return React.createElement('div', { className: 'dshDimaList' }, catalog.value.workspaces.map(item =>
          React.createElement('button', {
            key: item.cwd, type: 'button', onClick: () => { setCwd(item.cwd); setSessionId(undefined); setSelectedBranch(undefined) },
          }, item.cwd)))
      }
      if (!session) {
        if (workspace.sessions.length === 0) return React.createElement('p', null, t('dimaNoSessions'))
        return React.createElement('div', { className: 'dshDimaList' }, workspace.sessions.map(item =>
          React.createElement('button', {
            key: item.sessionId, type: 'button', onClick: () => { setSessionId(item.sessionId); setSelectedBranch(undefined) },
          }, item.title || item.sessionId)))
      }
      if (branchId === undefined) return React.createElement('p', null, t('dimaNoBranches'))
      return React.createElement(React.Fragment, null,
        React.createElement('label', { className: 'dshDimaBranch' }, t('dimaBranch'),
          React.createElement('select', {
            value: branchId, onChange: (event: Event) => setSelectedBranch((event.target as HTMLSelectElement).value),
          }, session.branches.map(id => React.createElement('option', { key: id, value: id }, id)))),
        React.createElement(Transcript, { key: JSON.stringify([session.sessionId, branchId]), control, source, sessionId: session.sessionId, branchId, revision: historyRevision, t }))
    }
    return React.createElement('section', {
      className: 'dshRemotePage', role: 'dialog', 'aria-modal': true, 'aria-label': title, tabIndex: -1, ref: page,
    },
    React.createElement('header', { className: 'dshRemotePageHeader' },
      React.createElement('div', { className: 'dshRemotePageIntro' },
        React.createElement('strong', null, title),
        React.createElement('p', null, workspace?.cwd ?? t('dimaWorkspaces'))),
      React.createElement('div', { className: 'dshRemotePageActions' },
        React.createElement('button', { type: 'button', className: 'dshRemotePageBack', onClick: goBack }, t('dimaBack')),
        React.createElement('button', {
          type: 'button', className: 'dshRemotePageRefresh', disabled: !catalog,
          onClick: () => session && branchId !== undefined ? setHistoryRevision(value => value + 1) : setCatalogRevision(value => value + 1),
        }, t('refreshRemoteShort')),
        React.createElement('button', { type: 'button', className: 'dshRemotePageClose', 'aria-label': t('close'), onClick: props.onClose }, '×'))),
    React.createElement('main', { className: 'dshRemotePageBody dshDimaBody' },
      workspace === undefined ? null : React.createElement('h3', null, session === undefined ? t('dimaSessions') : session.title || session.sessionId),
      body()))
  }
}
