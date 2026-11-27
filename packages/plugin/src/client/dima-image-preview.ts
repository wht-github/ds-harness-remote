import { isDimaImageMediaType, readDimaImage, type DimaImageReference, type DimaMediaReadRequest, type DimaMediaReadResult } from '@dsh-remote/protocol'
import type { Translate } from '../client-locale.js'
import { messageOf } from './presentation.js'
import type { ClientReact } from './types.js'

export type DimaImageRead = (request: DimaMediaReadRequest) => Promise<DimaMediaReadResult>
type Preview = { controller: AbortController; url?: string }
type Display = { read: DimaImageRead; key: string; url?: string; error?: string }

export function createDimaImagePreview(React: ClientReact) {
  const h = React.createElement
  const useLayout = React.useLayoutEffect ?? React.useEffect
  return function ImagePreview({ reference, read, t }: { reference: DimaImageReference; read: DimaImageRead; t: Translate }) {
    const { sessionId, branchId, sequence, fileId, mediaType } = reference
    const key = JSON.stringify([sessionId, branchId, sequence, fileId, mediaType])
    const active = React.useRef<Preview | undefined>(undefined)
    const dialog = React.useRef<HTMLDialogElement | null>(null)
    const [display, setDisplay] = React.useState<Display | undefined>(undefined)
    const shown = display?.read === read && display.key === key ? display : undefined

    function release() {
      const held = active.current
      if (!held) return
      active.current = undefined
      held.controller.abort()
      if (held.url) URL.revokeObjectURL(held.url)
    }
    function close() {
      release()
      dialog.current?.close()
      setDisplay(undefined)
    }
    useLayout(() => {
      setDisplay(undefined)
      return release
    }, [key, read])
    useLayout(() => {
      const el = dialog.current
      if (shown && el && !el.open) el.showModal()
      return () => { if (el?.open) el.close() }
    }, [Boolean(shown)])
    async function open() {
      if (active.current || !isDimaImageMediaType(mediaType)) return
      const held: Preview = { controller: new AbortController() }
      active.current = held
      const view = { key, read }
      setDisplay(view)
      try {
        const image = await readDimaImage(reference, read, held.controller.signal)
        if (active.current !== held) return
        if (image.mediaType !== mediaType || !isDimaImageMediaType(image.mediaType)) throw Error(t('dimaUnavailable'))
        held.url = URL.createObjectURL(new Blob([image.bytes], { type: image.mediaType }))
        setDisplay({ ...view, url: held.url })
      } catch (error) {
        if (active.current === held) setDisplay({ ...view, error: messageOf(error, t) })
      }
    }
    const title = t('dimaPreviewImage') + ' · ' + fileId
    return h(React.Fragment, null,
      h('button', { type: 'button', onClick: () => void open(), 'aria-haspopup': 'dialog' }, title),
      shown ? h('dialog', { ref: dialog, 'aria-label': title, onCancel: (e: Event) => { e.preventDefault(); close() },
        style: { maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', overflowWrap: 'anywhere' } },
          h('span', null, mediaType + ' · ' + fileId), h('button', { type: 'button', autoFocus: true, onClick: close }, t('close'))),
        shown.error ? h('p', { role: 'alert' }, shown.error) : shown.url ? h('img', { src: shown.url, alt: title,
          style: { display: 'block', maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' },
          onError: () => {
            if (active.current?.url !== shown.url) return
            release()
            setDisplay({ key, read, error: t('dimaUnavailable') })
          } }) : h('p', { role: 'status' }, t('dimaLoading'))) : null)
  }
}
