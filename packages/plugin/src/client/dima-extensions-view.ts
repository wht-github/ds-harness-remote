import type { DimaExtension, DimaExtensions, DimaFeatures } from '@dsh-remote/protocol'
import type { Translate } from '../client-locale.js'
import type { DimaOperationCall } from './dima-controls-view.js'
import type { ClientReact } from './types.js'
import { messageOf } from './presentation.js'

export function createDimaExtensions(React: ClientReact) {
  const h = React.createElement
  return function Extensions({ cwd, local, operation, features, uuid, t }: { cwd: string; local: boolean; operation: DimaOperationCall; features: DimaFeatures; uuid: () => string; t: Translate }) {
    const [open, setOpen] = React.useState(false)
    const [catalog, setCatalog] = React.useState<DimaExtensions | undefined>(undefined)
    const [error, setError] = React.useState<unknown>(undefined)
    const [revision, setRevision] = React.useState(0)
    const [pending, setPending] = React.useState(false)
    const lock = React.useRef(false)
    const alive = React.useRef(false)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    React.useEffect(() => {
      if (!open) return
      let live = true
      setCatalog(undefined)
      void operation('extensions', { cwd }).then(v => { if (live) setCatalog(v) }, e => { if (live) setError(e) })
      return () => { live = false }
    }, [cwd, open, operation, revision])
    const toggle = async (item: DimaExtension) => {
      if (!item.canToggle || item.enabled === null || !features.setExtension || lock.current) return
      const action = t(item.enabled ? 'dimaDisable' : 'dimaEnable'), scope = t(item.scope === 'host' ? 'dimaHostScope' : 'dimaWorkspaceScope')
      if (!window.confirm(t('dimaChangeExtension', { action, scope, item: item.name }))) return
      lock.current = true; setPending(true); setError(undefined)
      try { await operation('setExtension', { cwd, operationId: uuid(), kind: item.kind, id: item.id, scope: item.scope, source: item.source, revision: item.revision, enabled: !item.enabled }) }
      catch (e) { if (alive.current) setError(e) }
      finally { lock.current = false; if (alive.current) { setPending(false); setRevision(r => r + 1) } }
    }
    return h('details', { className: 'dshDimaExt', onToggle: (e: Event) => setOpen((e.target as HTMLDetailsElement).open) },
      h('summary', null, t('dimaExtensions')), open && h('div', null,
        h('button', { onClick: () => { setError(undefined); setRevision(r => r + 1) }, disabled: pending }, t('refreshRemoteShort')),
        error ? h('p', { role: 'alert' }, messageOf(error, t)) : null,
        catalog?.items.length === 0 ? h('p', null, t('dimaEmptyExtensions')) : null,
        catalog?.items.map(item => h('div', { key: JSON.stringify([item.kind, item.source, item.id]), className: 'dshDimaQueueRow' },
          h('strong', null, item.name), h('small', null, item.kind, ' · ', item.source, ' · ', t(item.scope === 'host' ? 'dimaHostScope' : 'dimaWorkspaceScope')),
          h('span', null, t(item.enabled === null ? 'dimaUnavailable' : item.enabled ? 'dimaEnabled' : 'dimaDisabled')),
          local && item.nativeToggleSupported === true ? h('details', null, h('summary', null, t('dimaGrantFile')), h('code', null, '$DSH_HOME/ds-harness-remote/dima-extension-grants.json'),
            h('pre', null, JSON.stringify({ grants: [{ kind: item.kind, id: item.id, source: item.source, ...(item.scope === 'workspace' && { cwd: catalog.cwd }) }] }, null, 2))) : null,
          features.setExtension && item.canToggle && item.enabled !== null ? h('button', { disabled: pending, onClick: () => void toggle(item) }, t(item.enabled ? 'dimaDisable' : 'dimaEnable')) : null))))
  }
}
