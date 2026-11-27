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
} from '@dsh-remote/protocol'
import * as Clipboard from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { File } from 'expo-file-system'
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy'
import * as ImagePicker from 'expo-image-picker'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { strings } from '../locales/i18n'
import type { DimaClient } from '../services/dima'
import { Button, ErrorBanner } from '../ui/components'
import { useTheme } from '../ui/theme-context'
import { bytesToBase64 } from './chat-files'

/** The chat route owns one transient memory object per Host, Session and branch. */
export type DimaMediaMemory = { items: Item[]; signal?: AbortSignal }

type Prepare = () => Promise<DimaMediaReference[]>
interface Props {
  available?: { image: boolean; paste: boolean; file: boolean }
  memory?: DimaMediaMemory
  client: DimaClient
  target: DimaHistoryRequest
  features: DimaFeatures
  signal: AbortSignal
  disabled: boolean
  onPrepare: (value: Prepare | null) => void
  resetKey: number
  onReading?: (active: boolean) => void
}

export function DimaMedia({
  client,
  target,
  features,
  available,
  memory,
  signal,
  disabled,
  onPrepare,
  onReading,
  resetKey,
}: Props) {
  const { colors } = useTheme()
  const [items, setItems] = useState<Item[]>(() => {
    if (!memory) return []
    if (memory.signal === signal) return memory.items
    // A new connection may reach a restarted daemon. Keep the explicit local selection,
    // and acquire a new upload handle only on the operator's next submission.
    return renewDimaMediaUploads(memory.items, randomUUID)
  })
  const priorReset = useRef(resetKey)
  useLayoutEffect(() => {
    if (memory) {
      memory.items = items
      memory.signal = signal
    }
  }, [memory, items, signal])
  const [query, setQuery] = useState<string>()
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const active = useRef(false)
  const generation = useRef(0)
  const waiting = useRef(false)
  const notifyReading = useRef(onReading)
  notifyReading.current = onReading
  const publish = useRef(onPrepare)
  publish.current = onPrepare
  const labels = strings.dima
  const canImage = features.mediaSubmit && features.mediaUpload && available?.image === true
  const canPaste = features.mediaSubmit && features.mediaUpload && available?.paste === true
  const canFile = features.mediaSubmit && features.mediaSearch && available?.file === true
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current++
      notifyReading.current?.(false)
    }
  }, [])
  useLayoutEffect(() => {
    if (resetKey === priorReset.current) return
    priorReset.current = resetKey
    if (memory) memory.items = []
    setItems([])
    setQuery(undefined)
    setFiles([])
    setError('')
    generation.current++
  }, [resetKey, memory])
  useEffect(() => {
    const callback = publish.current
    callback(
      !items.length
        ? null
        : async () => {
            const parts: DimaMediaReference[] = []
            const allowed = { image: canImage, paste: canPaste, file: canFile }
            for (const item of items) {
              if (!allowed['path' in item ? 'file' : item.upload.kind]) throw new Error(strings.dima.unavailable)
              if (!active.current || signal.aborted) throw new Error(strings.dima.unavailable)
              parts.push(
                'path' in item
                  ? { type: 'file', path: item.path }
                  : await prepareDimaUpload(item.upload, target, (request) =>
                      client.operation('mediaUpload', request, signal),
                    ),
              )
            }
            if (!active.current || signal.aborted) throw new Error(strings.dima.unavailable)
            return parts
          },
    )
    return () => callback(null)
  }, [items, client, target.sessionId, target.branchId, signal, canImage, canPaste, canFile])
  const append = (add: Item[]) => {
    const selected = [...items, ...add]
    if (
      selected.length >= DIMA_MEDIA_MAX_PARTS ||
      selected.filter((item) => 'upload' in item && item.upload.kind === 'image').length > DIMA_MEDIA_MAX_IMAGES
    )
      throw new Error(labels.mediaLimits)
    setItems((prev) => [...prev, ...add])
  }
  const run = async (work: (alive: () => boolean) => Promise<void>) => {
    if (waiting.current || signal.aborted || disabled) return
    waiting.current = true
    setReading(true)
    notifyReading.current?.(true)
    setError('')
    const version = generation.current
    const alive = () => active.current && !signal.aborted && version === generation.current
    try {
      await work(alive)
    } catch (e) {
      if (alive()) setError(e instanceof Error ? e.message : String(e))
    } finally {
      waiting.current = false
      if (active.current) {
        setReading(false)
        notifyReading.current?.(false)
      }
    }
  }
  const stage = (kind: DimaDraftUpload['kind'], label: string, size: number, read: DimaDraftUpload['readBase64']): Item => {
    if (!Number.isSafeInteger(size) || size <= 0 || size > (kind === 'paste' ? DIMA_PASTE_MAX_BYTES : DIMA_IMAGE_MAX_BYTES))
      throw new Error(labels.mediaLimits)
    return { label, upload: { kind, uploadId: randomUUID(), totalBytes: size, nextOffset: 0, readBase64: read } }
  }
  const pick = () =>
    void run(async (alive) => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        quality: 1,
      })
      if (!alive() || result.canceled) return
      const rows = result.assets.map((asset) => {
        const file = new File(asset.uri)
        return stage('image', asset.fileName ?? labels.mediaImage, file.size, (offset, length) =>
          readAsStringAsync(file.uri, { encoding: EncodingType.Base64, position: offset, length }),
        )
      })
      append(rows)
    })
  const paste = () =>
    void run(async (alive) => {
      if (canImage && (await Clipboard.hasImageAsync())) {
        if (!alive()) return
        const image = await Clipboard.getImageAsync({ format: 'png' })
        if (!alive() || !image) return
        const encoded = image.data.replace(/^data:image\/png;base64,/, '')
        const size = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
        append([
          stage('image', labels.mediaImage, size, async (offset, length) =>
            encoded.slice((offset / 3) * 4, (offset / 3) * 4 + 4 * Math.ceil(length / 3)),
          ),
        ])
      } else if (canPaste) {
        const text = await Clipboard.getStringAsync()
        if (!alive() || !text) return
        if (text.length > DIMA_PASTE_MAX_BYTES) throw new Error(labels.mediaLimits)
        const bytes = new TextEncoder().encode(text)
        append([
          stage('paste', labels.mediaPaste, bytes.length, async (offset, length) =>
            bytesToBase64(bytes.subarray(offset, offset + length)),
          ),
        ])
      }
    })
  const search = () =>
    void run(async (alive) => {
      const result = await client.operation(
        'mediaSearch',
        { sessionId: target.sessionId, branchId: target.branchId, query: query ?? '' },
        signal,
      )
      if (alive()) setFiles(result.files)
    })
  if (!canImage && !canPaste && !canFile && !items.length) return null
  const blocked = disabled || reading
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {canImage && <Button variant="secondary" label={labels.mediaImage} disabled={blocked} onPress={pick} />}
        {(canImage || canPaste) && (
          <Button variant="secondary" label={labels.mediaPaste} disabled={blocked} onPress={paste} />
        )}
        {canFile && (
          <Button
            variant="secondary"
            label={'@ ' + labels.mediaFile}
            disabled={blocked}
            onPress={() => {
              setQuery(query === undefined ? '' : undefined)
              setFiles([])
              generation.current++
            }}
          />
        )}
      </View>
      {canFile && query !== undefined && (
        <>
          <TextInput
            accessibilityLabel={labels.mediaFile}
            placeholder={labels.mediaFile}
            placeholderTextColor={colors.muted}
            value={query}
            editable={!blocked}
            maxLength={4096}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ color: colors.ink }}
            onChangeText={(value) => {
              setQuery(value)
              setFiles([])
              generation.current++
            }}
            onSubmitEditing={search}
          />
          <Button variant="secondary" label={labels.mediaSearch} disabled={blocked} onPress={search} />
          {files.map((path) => (
            <Button
              key={path}
              variant="quiet"
              label={path}
              disabled={blocked}
              onPress={() => {
                try {
                  append([{ path, label: '@' + path }])
                  setQuery(undefined)
                  setFiles([])
                } catch (e) {
                  setError(String(e))
                }
              }}
            />
          ))}
        </>
      )}
      {items.map((item, i) => (
        <View
          key={'upload' in item ? item.upload.uploadId : i}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Text numberOfLines={2} style={{ color: colors.ink, flex: 1 }}>
            {'path' in item
              ? labels.mediaFile + ' · ' + item.label
              : item.upload.kind === 'image'
                ? labels.mediaImage + ' · ' + item.label
                : item.label}
          </Text>
          <Button
            variant="quiet"
            label={labels.mediaRemove}
            disabled={blocked}
            onPress={() => setItems((prev) => prev.filter((_, j) => j !== i))}
          />
        </View>
      ))}
      {error ? <ErrorBanner message={error} onDismiss={() => setError('')} /> : null}
    </View>
  )
}
