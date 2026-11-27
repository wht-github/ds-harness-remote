import type { Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import type { ClientReact, RemoteStatus } from './types.js'
import { createDimaBrowser, dimaSourceConnection, DimaBrowserMemory, type DimaSource } from './dima-browser.js'
import type { DimaLanguage } from './dima-controls-view.js'

export type DimaMainSelection = { source: DimaSource; sourceName: string }
export function createDimaMainPanel(React: ClientReact) {
  const panelId = 'ds-harness-remote.dimagent'
  const Browser = createDimaBrowser(React)
  const memory = new DimaBrowserMemory()
  const listeners = new Set<() => void>()
  let selection: DimaMainSelection | undefined
  const read = () => selection
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const select = (next: DimaMainSelection | undefined) => { selection = next; for (const notify of listeners) notify() }
  function Panel(props: { control: <T>(key: string, payload: unknown) => Promise<T>; t: Translate; lang: DimaLanguage; statusFeed: StatusFeed<RemoteStatus>; close: () => void }) {
    const current = React.useSyncExternalStore(subscribe, read, read)
    const status = React.useSyncExternalStore(props.statusFeed.subscribe, props.statusFeed.getSnapshot)
    const ready = current?.source.target === 'local' || (current?.source.target === 'remote' && status?.connected && status.connectedTargetDeviceId === current.source.targetDeviceId && status.remoteFeatures?.dima)
    if (!current || !ready) return React.createElement('section', { className: 'dshDimaMain dshRemotePage' }, React.createElement('p', { role: 'status' }, props.t('dimaUnavailable')),
      React.createElement('button', { onClick: props.close }, props.t('dimaBack')))
    const connection = dimaSourceConnection(current.source, status)
    return React.createElement(Browser, { ...current, key: JSON.stringify([current.source, connection]), connection, interactionAvailable: current.source.target === 'local' || status?.remoteFeatures?.dimaInteraction === true,
      control: props.control, memory, lang: props.lang, t: props.t, mainPanel: true, onBack: props.close, onClose: props.close })
  }
  return { panelId, select, Panel }
}
