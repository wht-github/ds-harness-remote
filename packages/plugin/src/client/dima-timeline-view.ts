import MarkdownIt from 'markdown-it'
import { isDimaImageReference, mergeDimaTimelinePages } from '@dsh-remote/protocol'
import type { DimaTimeline, DimaTimelineBlock, DimaTimelineRequest, DimaTimelineTurn } from '@dsh-remote/protocol'
import type { Translate } from '../client-locale.js'
import type { ClientReact } from './types.js'
import { messageOf } from './presentation.js'
import { createDimaImagePreview, type DimaImageRead } from './dima-image-preview.js'
import type { DimaTimelineReading, ReadingAnchor } from './dima-timeline-memory.js'

type TurnFormats = { clock: Intl.DateTimeFormat; seconds: Intl.NumberFormat; count: Intl.NumberFormat }

function rateLimited(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { code, details } = error as { code?: string; details?: { remoteCode?: string } }
  return code === 'RATE_LIMITED' || details?.remoteCode === 'RATE_LIMITED'
}

function anchorIn(view: HTMLElement, force = false): ReadingAnchor | undefined {
  if (!force && view.scrollHeight - view.scrollTop - view.clientHeight < 40) return
  const top = view.getBoundingClientRect().top
  const turn = Array.from(view.querySelectorAll<HTMLElement>('[data-dima-turn]')).find(el => el.getBoundingClientRect().bottom > top)
  if (!turn) return
  const block = Array.from(turn.querySelectorAll<HTMLElement>('[data-dima-anchor]')).find(el => el.getBoundingClientRect().bottom > top)
  return { turnId: turn.dataset.dimaTurn!, sequence: Number(turn.dataset.sequence), blockId: block?.dataset.dimaAnchor,
    top: (block ?? turn).getBoundingClientRect().top - top }
}

function restoreAnchor(view: HTMLElement, anchor?: ReadingAnchor) {
  if (!anchor) { view.scrollTop = view.scrollHeight; return }
  const turns = Array.from(view.querySelectorAll<HTMLElement>('[data-dima-turn]'))
  const turn = turns.find(el => el.dataset.dimaTurn === anchor.turnId)
  const block = turn && Array.from(turn.querySelectorAll<HTMLElement>('[data-dima-anchor]')).find(el => el.dataset.dimaAnchor === anchor.blockId)
  const row = block ?? turn ?? turns.find(el => Number(el.dataset.sequence) >= anchor.sequence) ?? turns.at(-1)
  if (row) view.scrollTop += row.getBoundingClientRect().top - view.getBoundingClientRect().top - (block || turn ? anchor.top : 0)
}

const markdown = new MarkdownIt({ html: false, linkify: false })
markdown.validateLink = href => /^(https?:\/\/|mailto:)/i.test(href)
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? '')
markdown.renderer.rules.link_open = (tokens, idx, options, _env, renderer) => {
  tokens[idx]?.attrSet('target', '_blank')
  tokens[idx]?.attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, idx, options)
}

export function createDimaMarkdown(React: ClientReact) {
  return function Markdown({ text }: { text: string }): unknown {
    const html = React.useMemo(() => ({ __html: markdown.render(text) }), [text])
    return React.createElement('div', { className: 'dshDimaMarkdown', dangerouslySetInnerHTML: html })
  }
}

export function createDimaTimeline(React: ClientReact) {
  const h = React.createElement
  const Markdown = createDimaMarkdown(React)
  const ImagePreview = createDimaImagePreview(React)
  function Block({ block, turnId, reading, t }: { block: DimaTimelineBlock; turnId: string; reading: DimaTimelineReading; t: Translate }): unknown {
    if (block.kind === 'text') return h(Markdown, { text: block.text })
    if (block.kind === 'user') return h('div', { className: 'dshDimaUserText' }, block.text)
    const key = JSON.stringify([turnId, block.kind, block.id])
    const details = { className: 'dshDimaDetail', open: reading.expanded.get(key) ?? false, onToggle: (event: Event) => {
      const el = event.currentTarget as HTMLDetailsElement
      if (el.isConnected && el.open !== (reading.expanded.get(key) ?? false)) reading.setExpanded(key, el.open)
    } }
    if (block.kind === 'thinking') return h('details', details, h('summary', null, t('dimaThinking')), h(Markdown, { text: block.text }))
    return h('details', details,
      h('summary', null, block.tool || t('dimaTools'), block.state === 'running' ? ' …' : '', block.state === 'failed' ? ' ×' : ''),
      block.input ? h('pre', { 'aria-label': t('dimaInput') }, block.input) : null,
      block.output ? h('pre', { 'aria-label': t('dimaOutput') }, block.output) : null,
      block.diff ? h('pre', { 'aria-label': t('dimaDiff') }, block.diff) : null,
      block.text && block.text !== block.output ? h('p', null, block.text) : null,
      block.truncated ? h('small', null, t('dimaPartial')) : null)
  }
  function Turn({ turn, t, sessionId, branchId, readImage, reading, formats }: {
    turn: DimaTimelineTurn; t: Translate; sessionId: string; branchId: string; readImage?: DimaImageRead; reading: DimaTimelineReading; formats: TurnFormats
  }): unknown {
    const [, redraw] = React.useState(0)
    const rows = [] as unknown[]
    // Consecutive process blocks stay together. A user input or the final answer remains in native order.
    let group: DimaTimelineBlock[] = []
    const flush = () => {
      const first = group[0]
      if (!first) return
      const key = JSON.stringify([turn.id, 'process', first.id])
      const expanded = reading.expanded.get(key) ?? turn.status === 'running'
      rows.push(h('div', { key: first.id, className: 'dshDimaProcess', 'data-dima-anchor': first.id },
        h('button', { type: 'button', 'aria-expanded': expanded, onClick: () => { reading.setExpanded(key, !expanded); redraw(v => v + 1) } }, t('dimaProcess'), ' ', expanded ? '▾' : '▸'),
        expanded ? group.map(block => h(Block, { key: block.id, block, turnId: turn.id, reading, t })) : null))
      group = []
    }
    const last = turn.blocks.at(-1)
    for (const block of turn.blocks) {
      if (block.kind === 'user' || (block.kind === 'text' && (block === last || turn.status === 'running'))) {
        flush()
        const attachments = block.kind === 'user' && !block.live ? block.attachments : undefined
        rows.push(h('div', { key: block.id, 'data-dima-anchor': block.id }, h(Block, { block, turnId: turn.id, reading, t }),
          attachments?.map(({ fileId, mediaType }, i) => {
            const key = JSON.stringify([sessionId, branchId, block.sequence, fileId, mediaType, i])
            const reference = { sessionId, branchId, sequence: block.sequence, fileId, mediaType }
            return readImage && isDimaImageReference(reference)
              ? h(ImagePreview, { key, reference, read: readImage, t })
              : h('small', { key, style: { display: 'block', overflowWrap: 'anywhere' } }, mediaType + ' · ' + fileId)
          })))
      } else group.push(block)
    }
    flush()
    if (turn.status === 'failed' || turn.status === 'cancelled') rows.push(h('p', { key: 'outcome', role: 'status' },
      h('strong', null, t(turn.status === 'failed' ? 'dimaTurnFailed' : 'dimaTurnStopped')), turn.detail ? ' ' + turn.detail : ''))
    const metadata: unknown[] = []
    for (const [value, label] of [[turn.startedAt, 'dimaTurnStart'], [turn.endedAt, 'dimaTurnEnd']] as const) {
      if (value === undefined) continue
      const date = new Date(value)
      if (Number.isFinite(date.valueOf())) metadata.push(h('time', { key: label, dateTime: date.toISOString() }, t(label) + ' ' + formats.clock.format(date)))
    }
    if (turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt >= turn.startedAt) {
      metadata.push(h('span', { key: 'duration' }, formats.seconds.format((turn.endedAt - turn.startedAt) / 1000)))
    }
    if (turn.usage?.length) {
      const requests = new Map(turn.usage.map(row => [row.requestId, row]))
      let total = 0, input = 0, output = 0
      for (const receipt of requests.values()) { total += receipt.totalTokens; input += receipt.promptTokens; output += receipt.completionTokens }
      metadata.push(h('span', { key: 'usage' }, t('dimaTurnTokens', { total: formats.count.format(total), input: formats.count.format(input), output: formats.count.format(output) })))
    }
    return h('article', { className: 'dshDimaTurn', 'data-dima-turn': turn.id, 'data-sequence': turn.sequence }, rows,
      metadata.length ? h('small', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.8rem' } }, ...metadata) : null)
  }
  return function Timeline(props: {
    readPage: (cursor?: DimaTimelineRequest['cursor']) => Promise<DimaTimeline>; readImage?: DimaImageRead
    revision: number; t: Translate; lang: string; reading: DimaTimelineReading
  }): unknown {
    const { readPage, revision, t, reading, lang } = props
    const formats = React.useMemo<TurnFormats>(() => ({
      clock: new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      seconds: new Intl.NumberFormat(lang, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }),
      count: new Intl.NumberFormat(lang),
    }), [lang])
    const [page, setPage] = React.useState<DimaTimeline | undefined>(undefined)
    const [error, setError] = React.useState<unknown>(undefined)
    const [loadingEarlier, setLoadingEarlier] = React.useState(false)
    const [selection, setSelection] = React.useState<string | undefined>(undefined)
    const container = React.useRef<HTMLDivElement | null>(null)
    const latest = React.useRef<DimaTimeline | undefined>(undefined)
    const displayed = React.useRef<DimaTimeline | undefined>(undefined)
    const earlierRead = React.useRef<symbol | undefined>(undefined)
    const useLayout = React.useLayoutEffect ?? React.useEffect

    function detached() {
      return !!(latest.current && reading.page && latest.current.to > reading.page.to)
    }
    function remember(force = false) {
      if (!container.current || !displayed.current) return
      reading.anchor = anchorIn(container.current, force || detached())
      setSelection(reading.anchor?.turnId)
    }
    function display(value: DimaTimeline) {
      reading.page = value
      setPage(value)
    }
    function failure(reason: unknown) {
      if (rateLimited(reason)) {
        reading.retryDelay = Math.min(30_000, (reading.retryDelay || 2500) * 2)
        reading.retryAt = Date.now() + reading.retryDelay
      }
      setError(reason)
    }
    useLayout(() => {
      displayed.current = page
      if (!page || !container.current) return
      restoreAnchor(container.current, reading.anchor)
      if (reading.anchor) remember(true)
      else setSelection(undefined)
    }, [page])
    useLayout(() => {
      const view = container.current
      setLoadingEarlier(false)
      return () => {
        // A reconnect can unmount the panel before the browser dispatches its last scroll event.
        if (displayed.current && view?.isConnected && view.clientHeight > 0) reading.anchor = anchorIn(view, detached())
        earlierRead.current = undefined
      }
    }, [readPage, reading])
    React.useEffect(() => {
      let live = true, busy = false
      let timer: ReturnType<typeof setTimeout> | undefined
      function schedule(delay: number) {
        clearTimeout(timer)
        if (live && !document.hidden) timer = setTimeout(() => void sample(), Math.max(delay, reading.retryAt - Date.now()))
      }
      async function sample() {
        clearTimeout(timer)
        if (!live || busy || document.hidden) return
        if (reading.retryAt > Date.now()) { schedule(0); return }
        busy = true
        let delay = 5000
        try {
          const next = await readPage()
          if (!live) return
          if (displayed.current?.instanceId === next.instanceId) remember()
          reading.observeDaemon(next.instanceId)
          const prior = reading.page
          const combined = prior ? mergeDimaTimelinePages(prior, next) : next
          // A refresh can discard an older window on a gap or retention boundary.
          // Keep that window and its earlier cursor while the operator is reading it.
          latest.current = next
          display(prior && reading.anchor && combined.from > prior.from ? prior : combined)
          reading.retryAt = reading.retryDelay = 0
          setError(undefined)
          delay = next.activity?.running || next.activity?.stopping ? 650 : 5000
        } catch (reason) { if (live) failure(reason) }
        finally { busy = false; schedule(delay) }
      }
      const visibility = () => { if (document.hidden) clearTimeout(timer); else void sample() }
      void sample()
      document.addEventListener('visibilitychange', visibility)
      return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
    }, [readPage, revision, reading])

    const earlier = async () => {
      const cursor = reading.page?.earlier
      if (!cursor || earlierRead.current || document.hidden || reading.retryAt > Date.now()) return
      const token = Symbol()
      earlierRead.current = token
      setLoadingEarlier(true)
      try {
        const older = await readPage(cursor)
        const current = reading.page
        if (earlierRead.current !== token || !current || current.instanceId !== older.instanceId || current.earlier?.before !== cursor.before) return
        remember(true)
        display(mergeDimaTimelinePages(older, current))
        setError(undefined)
      } catch (reason) { if (earlierRead.current === token) failure(reason) }
      finally { if (earlierRead.current === token) { earlierRead.current = undefined; setLoadingEarlier(false) } }
    }
    function jumpTo(turnId: string) {
      const view = container.current
      const turn = page?.turns.find(item => item.id === turnId)
      if (!view || !turn) return
      restoreAnchor(view, { turnId, sequence: turn.sequence, top: 0 })
      remember()
    }
    function jumpLatest() {
      if (!container.current) return
      reading.anchor = undefined
      setSelection(undefined)
      if (latest.current && reading.page && latest.current.to > reading.page.to) display(mergeDimaTimelinePages(reading.page, latest.current))
      restoreAnchor(container.current)
    }
    return h('div', { className: 'dshDimaHistory', style: { flexDirection: 'column' } },
      page && page.turns.length > 1 ? h('label', { className: 'dshDimaBranch' }, t('dimaLoadedTurns'),
        h('select', { value: selection ?? page.turns.at(-1)?.id, onChange: (event: Event) => jumpTo((event.target as HTMLSelectElement).value) },
          page.turns.map(turn => {
            const first = turn.blocks.find(block => block.kind === 'user' && block.text.trim()) ?? turn.blocks.find(block => block.text.trim())
            const summary = first?.text.trim().slice(0, 80).replace(/\s+/g, ' ')
            return h('option', { key: turn.id, value: turn.id }, summary ? turn.sequence + ' · ' + summary : turn.id)
          }))) : null,
      h('div', { className: 'dshDimaScroll', style: { flex: '1 1 auto', minHeight: 0, overflowAnchor: 'none' }, ref: container, tabIndex: 0, onScroll: () => remember() },
        page?.earlier ? h('button', { type: 'button', disabled: loadingEarlier || reading.retryAt > Date.now(), onClick: () => void earlier() }, t(loadingEarlier ? 'dimaLoading' : 'dimaLoadOlder')) : null,
        page?.turns.map(turn => h(Turn, { key: JSON.stringify([page.instanceId, turn.id]), turn, t, sessionId: page.sessionId, branchId: page.branchId, readImage: props.readImage, reading, formats })),
        !page && !error ? h('p', { role: 'status' }, t('dimaLoading')) : null,
        page && !page.turns.length ? h('p', null, t('dimaNoMessages')) : null,
        error ? h('p', { className: 'dshRemoteError', role: 'alert' }, messageOf(error, t)) : null),
      page && (selection || detached()) ? h('button', { className: 'dshDimaJump', type: 'button', onClick: jumpLatest }, t('dimaJumpLatest')) : null)
  }
}
