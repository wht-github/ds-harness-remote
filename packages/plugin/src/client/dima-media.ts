import {
  DIMA_IMAGE_MAX_BYTES,
  DIMA_MEDIA_MAX_IMAGES,
  DIMA_MEDIA_MAX_PARTS,
  DIMA_PASTE_MAX_BYTES,
  prepareDimaUpload,
  renewDimaMediaUploads,
  type DimaDraftMediaItem as Item,
  type DimaDraftUpload,
  type DimaFeatures,
  type DimaHistoryRequest,
  type DimaMediaReference,
  type DimaOperation,
  type DimaOperationRequest,
  type DimaOperationResult,
} from '@dsh-remote/protocol'
import type { ClientReact } from './types.js'

type Operation = <K extends DimaOperation>(key: K, request: DimaOperationRequest<K>) => Promise<DimaOperationResult<K>>
/** The browser keeps one object per source Host, Session and branch. Blob readers stay local. */
export type DimaMediaMemory = { items: Item[]; paste?: string; connection?: unknown }
type Prepare = () => Promise<DimaMediaReference[]>
type Props = {
  available?: { image: boolean; paste: boolean; file: boolean }
  operation: Operation
  uuid: () => string
  memory: DimaMediaMemory
  connection?: unknown
  target: DimaHistoryRequest
  features: DimaFeatures
  lang: keyof typeof copy
  ready: boolean
  onPrepare: (value: Prepare | null) => void
  resetKey: number
}
const copy = {
  en: [
    'Image from device',
    'Paste text attachment',
    'Add',
    'Workspace file',
    'Search',
    'Remove',
    'Select up to 31 items. Up to 20 images, 16 MiB each. Text ≤10 MiB.',
    'This attachment is unavailable in the selected session.',
  ],
  zh: [
    '设备图片',
    '粘贴长文本附件',
    '添加',
    '工作区文件',
    '搜索',
    '移除',
    '最多 31 项。最多 20 张图片，每张 16 MiB，文本附件 10 MiB。',
    '当前会话不支持这项附件。',
  ],
  ru: [
    'Изображение с устройства',
    'Вставить текстовое вложение',
    'Добавить',
    'Файл проекта',
    'Поиск',
    'Удалить',
    'До 31 элемента. До 20 изображений по 16 МиБ, текст ≤10 МиБ.',
    'Это вложение недоступно в выбранном сеансе.',
  ],
  uk: [
    'Зображення з пристрою',
    'Вставити текстовий вкладений файл',
    'Додати',
    'Файл проєкту',
    'Пошук',
    'Видалити',
    'До 31 елемента. До 20 зображень по 16 МіБ, текст ≤10 МіБ.',
    'Це вкладення недоступне у вибраному сеансі.',
  ],
} as const

async function blobChunk(blob: Blob, offset: number, length: number): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  let data = ''
  for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(data)
}

export function createDimaMedia(React: ClientReact) {
  const h = React.createElement
  return function DimaMedia({
    operation,
    uuid,
    memory,
    connection,
    target,
    features,
    available,
    lang,
    ready,
    onPrepare,
    resetKey,
  }: Props) {
    const mount = React.useRef({})
    const lifetime = connection ?? mount.current
    const lastReset = React.useRef(resetKey)
    const [, invalidate] = React.useState(0)
    const { items, paste } = memory
    const setItems = (value: Item[]) => {
      memory.items = value
      invalidate((revision) => revision + 1)
    }
    const setPaste = (value: string | undefined) => {
      memory.paste = value
      invalidate((revision) => revision + 1)
    }
    const [query, setQuery] = React.useState<string | undefined>(undefined)
    const [files, setFiles] = React.useState<string[]>([])
    const [error, setError] = React.useState('')
    const root = React.useRef<HTMLElement | null>(null)
    const active = React.useRef(false)
    const generation = React.useRef(0)
    const picker = React.useRef<HTMLInputElement | null>(null)
    const state = React.useRef({ operation, onPrepare, lifetime, memory })
    state.current = { operation, onPrepare, lifetime, memory }
    const words = copy[lang] ?? copy.en
    const canImage = features.mediaSubmit && features.mediaUpload && available?.image === true
    const canPaste = features.mediaSubmit && features.mediaUpload && available?.paste === true
    const canFile = features.mediaSubmit && features.mediaSearch && available?.file === true
    const button = (label: string, click: () => void, disabled = false) =>
      h('button', { type: 'button', disabled: !ready || disabled, onClick: click }, label)
    const append = (rows: Item[]) => {
      const selected = [...memory.items, ...rows]
      if (
        selected.length >= DIMA_MEDIA_MAX_PARTS ||
        selected.filter((item) => 'upload' in item && item.upload.kind === 'image').length > DIMA_MEDIA_MAX_IMAGES
      ) {
        setError(words[6])
        return false
      }
      setItems(selected)
      setError('')
      return true
    }
    const addUploads = (blobs: Blob[], labels: string[], kind: DimaDraftUpload['kind']) => {
      if (blobs.some((blob) => !blob.size || blob.size > (kind === 'paste' ? DIMA_PASTE_MAX_BYTES : DIMA_IMAGE_MAX_BYTES))) {
        setError(words[6])
        return false
      }
      return append(
        blobs.map((blob, i) => ({
          label: labels[i]!,
          upload: {
            kind,
            uploadId: uuid(),
            totalBytes: blob.size,
            nextOffset: 0,
            readBase64: (offset, length) => blobChunk(blob, offset, length),
          },
        })),
      )
    }
    const addPaste = (value: string) => addUploads([new Blob([value])], [words[1]], 'paste')
    React.useEffect(() => {
      active.current = true
      return () => {
        active.current = false
        generation.current++
      }
    }, [])
    React.useEffect(() => {
      if (lastReset.current === resetKey) return
      lastReset.current = resetKey
      // The submitter clears only the exact draft acknowledged by the Host.
      setQuery(undefined)
      setFiles([])
      setError('')
      generation.current++
    }, [resetKey])
    React.useEffect(() => {
      const publish = state.current.onPrepare
      publish(
        !items.length
          ? null
          : async () => {
              const result: DimaMediaReference[] = []
              const allowed = { image: canImage, paste: canPaste, file: canFile }
              const current = () => active.current && state.current.memory === memory && state.current.lifetime === lifetime
              if (!current()) throw new DOMException('Cancelled', 'AbortError')
              if (memory.connection !== lifetime) {
                if (memory.connection !== undefined) {
                  setItems(renewDimaMediaUploads(memory.items, uuid))
                }
                memory.connection = lifetime
              }
              for (const item of memory.items) {
                if (!allowed['path' in item ? 'file' : item.upload.kind]) throw new Error(words[7])
                if (!current()) throw new DOMException('Cancelled', 'AbortError')
                result.push(
                  'path' in item
                    ? { type: 'file', path: item.path }
                    : await prepareDimaUpload(item.upload, target, (request) => {
                        if (!current()) throw new DOMException('Cancelled', 'AbortError')
                        return state.current.operation('mediaUpload', request)
                      }),
                )
              }
              if (!current()) throw new DOMException('Cancelled', 'AbortError')
              return result
            },
      )
      return () => publish(null)
    }, [items, memory, lifetime, target.sessionId, target.branchId, onPrepare, canImage, canPaste, canFile, words])
    React.useEffect(() => {
      const host = root.current?.closest<HTMLElement>('[data-dima-composer]') ?? root.current
      if (!host || !ready || (!canImage && !canPaste)) return
      const transfer = (data: DataTransfer | null) =>
        data ? Array.from(data.files).filter((f) => f.type.startsWith('image/')) : []
      const onPaste = (e: ClipboardEvent) => {
        if (e.target instanceof HTMLElement && e.target.hasAttribute('data-dima-paste')) return
        const images = transfer(e.clipboardData)
        if (canImage && images.length) {
          e.preventDefault()
          addUploads(
            images,
            images.map((i) => i.name || words[0]),
            'image',
          )
          return
        }
        const text = e.clipboardData?.getData('text/plain')
        if (canPaste && text && new Blob([text]).size > 16 * 1024) {
          e.preventDefault()
          addPaste(text)
        }
      }
      const onDrop = (e: DragEvent) => {
        const images = transfer(e.dataTransfer)
        if (canImage && images.length) {
          e.preventDefault()
          addUploads(
            images,
            images.map((i) => i.name || words[0]),
            'image',
          )
        }
      }
      const drag = (e: DragEvent) => {
        if (canImage && Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith('image/'))) e.preventDefault()
      }
      host.addEventListener('paste', onPaste)
      host.addEventListener('dragover', drag)
      host.addEventListener('drop', onDrop)
      return () => {
        host.removeEventListener('paste', onPaste)
        host.removeEventListener('dragover', drag)
        host.removeEventListener('drop', onDrop)
      }
    }, [ready, items, words, canPaste, canImage])
    const search = async () => {
      const seq = ++generation.current
      try {
        const result = await operation('mediaSearch', {
          sessionId: target.sessionId,
          branchId: target.branchId,
          query: query ?? '',
        })
        if (seq === generation.current) {
          setFiles(result.files)
          setError('')
        }
      } catch (e) {
        if (seq === generation.current) setError(e instanceof Error ? e.message : String(e))
      }
    }
    if (!canImage && !canPaste && !canFile && !items.length) return null
    return h(
      'div',
      { ref: root, style: { display: 'grid', gap: 6 } },
      h(
        'div',
        { className: 'dshRemotePageActions' },
        canImage ? button(words[0], () => picker.current?.click()) : null,
        canPaste ? button(words[1], () => setPaste(paste === undefined ? '' : undefined)) : null,
        canFile
          ? button('@ ' + words[3], () => {
              setQuery(query === undefined ? '' : undefined)
              setFiles([])
              generation.current++
            })
          : null,
      ),
      canImage
        ? h('input', {
            type: 'file',
            multiple: true,
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            hidden: true,
            ref: picker,
            onChange: (e: Event) => {
              const node = e.target as HTMLInputElement
              const images = Array.from(node.files ?? [])
              node.value = ''
              if (images.length)
                addUploads(
                  images,
                  images.map((i) => i.name),
                  'image',
                )
            },
          })
        : null,
      canPaste && paste !== undefined
        ? h(
            'div',
            null,
            h('textarea', {
              'data-dima-paste': '',
              'aria-label': words[1],
              value: paste,
              disabled: !ready,
              onChange: (e: Event) => setPaste((e.target as HTMLTextAreaElement).value),
            }),
            button(
              words[2],
              () => {
                if (addPaste(paste)) setPaste(undefined)
              },
              !paste.length,
            ),
          )
        : null,
      canFile && query !== undefined
        ? h(
            'div',
            null,
            h('input', {
              'aria-label': words[3],
              value: query,
              maxLength: 4096,
              disabled: !ready,
              onChange: (e: Event) => {
                setQuery((e.target as HTMLInputElement).value)
                setFiles([])
                generation.current++
              },
            }),
            button(words[4], () => void search()),
            ...files.map((path) =>
              h(
                'button',
                {
                  type: 'button',
                  key: path,
                  disabled: !ready,
                  onClick: () => {
                    if (append([{ path, label: '@' + path }])) {
                      setQuery(undefined)
                      setFiles([])
                    }
                  },
                },
                path,
              ),
            ),
          )
        : null,
      ...items.map((item, i) =>
        h(
          'div',
          { key: 'upload' in item ? item.upload.uploadId : i },
          'path' in item
            ? words[3] + ' · ' + item.label
            : item.upload.kind === 'image'
              ? words[0] + ' · ' + item.label
              : item.label,
          ' ',
          button(words[5], () => setItems(memory.items.filter((_, j) => j !== i))),
        ),
      ),
      error ? h('span', { role: 'alert' }, error) : null,
    )
  }
}
