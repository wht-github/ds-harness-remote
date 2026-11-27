import { DIMA_MAX_PROMPT_CHARS } from '@dsh-remote/protocol'
import type { DimaActionKind, DimaActionRequest, DimaActionResult, DimaFeatures, DimaHistoryRequest, DimaInbox, DimaMediaReference, DimaOperation, DimaOperationRequest, DimaOperationResult, DimaSessionOptions } from '@dsh-remote/protocol'
import type { LocaleKey, Translate } from '../client-locale.js'
import type { ClientReact } from './types.js'
import { messageOf } from './presentation.js'
import { createDimaMedia, type DimaMediaMemory } from './dima-media.js'
import { createDimaTasks } from './dima-tasks.js'

export type DimaOperationCall = <K extends DimaOperation>(key: K, request: DimaOperationRequest<K>) => Promise<DimaOperationResult<K>>
type ActionArgs<T = DimaActionRequest> = T extends DimaActionRequest ? Omit<T, 'sessionId' | 'branchId' | 'operationId'> : never
type QuestionBatch = DimaInbox['questions'][number]
type Answer = { questionId: string; selected: string[]; custom?: string }
export type DimaLanguage = 'en' | 'zh' | 'ru' | 'uk'

export function createDimaControls(React: ClientReact) {
  const h = React.createElement
  const Media = createDimaMedia(React)
  const Tasks = createDimaTasks(React)
  function Questions({ batch, ready, act, t }: { batch: QuestionBatch; ready: boolean; act: (action: ActionArgs) => void; t: Translate }) {
    const [answers, setAnswers] = React.useState<Answer[]>([])
    const update = (answer: Answer) => setAnswers(old => [...old.filter(row => row.questionId !== answer.questionId), answer])
    const { eventId, requestId, callId } = batch
    const complete = batch.questions.every(q => answers.some(row => row.questionId === q.id && (row.selected.length || row.custom?.trim())))
    return h('fieldset', { className: 'dshDimaDecision' }, h('legend', null, t('dimaAsk')),
      batch.questions.map(q => {
        const row = answers.find(a => a.questionId === q.id) ?? { questionId: q.id, selected: [] }
        return h('fieldset', { key: q.id }, h('legend', null, q.header ? q.header + ' · ' + q.question : q.question),
          q.options.map(option => h('label', { key: option.label }, h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: JSON.stringify([eventId, q.id]),
            checked: row.selected.includes(option.label), disabled: !ready, onChange: (e: Event) => {
              const checked = (e.target as HTMLInputElement).checked
              const selected = q.multiSelect ? [...row.selected.filter(s => s !== option.label), ...(checked ? [option.label] : [])] : [option.label]
              update({ ...row, selected, custom: q.multiSelect ? row.custom : undefined })
            } }), option.label, option.description ? h('small', null, option.description) : null)),
          q.allowCustom ? h('input', { type: 'text', 'aria-label': t('dimaOther'), placeholder: t('dimaOther'), value: row.custom ?? '', maxLength: DIMA_MAX_PROMPT_CHARS, disabled: !ready,
            onChange: (e: Event) => { const custom = (e.target as HTMLInputElement).value; update({ ...row, selected: !q.multiSelect && custom ? [] : row.selected, custom: custom || undefined }) } }) : null)
      }),
      h('div', { className: 'dshRemotePageActions' },
        h('button', { disabled: !ready || !complete, onClick: () => act({ kind: 'answer', eventId, requestId, callId, answers: batch.questions.map(q => answers.find(row => row.questionId === q.id)!) }) }, t('dimaAnswer')),
        h('button', { disabled: !ready, onClick: () => act({ kind: 'answer', eventId, requestId, callId, declined: true }) }, t('dimaDecline'))))
  }
  return function Controls(props: {
    t: Translate; lang: DimaLanguage; features: DimaFeatures; operation: DimaOperationCall; target: DimaHistoryRequest; legacyAvailable: boolean; legacyReady: boolean; operationsReady: boolean; mediaMemory: DimaMediaMemory; connection?: string; running: boolean; stopping: boolean; revision: number
    draft: string; setDraft: (text: string) => void; getDraft: () => string; submit: () => void; stop: () => Promise<unknown>; submitText: (text: string) => Promise<unknown>; uuid: () => string; refresh: () => void
    mutate: <T>(work: () => Promise<T>, consumeDraft?: boolean) => Promise<T | undefined>; onBranchChange: (result: DimaActionResult) => void
  }): unknown {
    const { t, features, operation, target, legacyReady, operationsReady, running, stopping, draft, setDraft, mutate } = props
    const [inbox, setInbox] = React.useState<DimaInbox | undefined>(undefined)
    const [options, setOptions] = React.useState<DimaSessionOptions | undefined>(undefined)
    const [open, setOpen] = React.useState(false)
    const [inboxError, setInboxError] = React.useState<unknown>(undefined)
    const [optionsError, setOptionsError] = React.useState<unknown>(undefined)
    const [hasParts, setHasParts] = React.useState(false)
    const [resetKey, setResetKey] = React.useState(0)
    const [lastDetail, setLastDetail] = React.useState('')
    const prepare = React.useRef<(() => Promise<DimaMediaReference[]>) | null>(null)
    const onPrepare = React.useCallback((prepareNow: (() => Promise<DimaMediaReference[]>) | null) => { prepare.current = prepareNow; setHasParts(prepareNow !== null) }, [])
    const mounted = React.useRef(false)
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    React.useEffect(() => {
      if (!features.inbox) return
      let live = true, busy = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const sample = async () => {
        clearTimeout(timer)
        if (document.hidden || busy) return
        busy = true
        let delay = running ? 1200 : 6500
        try {
          const result = await operation('inbox', target)
          if (live) { setInbox(result); setInboxError(undefined) }
          if (result.questions.length || result.queue.length) delay = 1200
        } catch (reason) { if (live) { setInbox(undefined); setInboxError(reason) } }
        finally { busy = false; if (live && !document.hidden) timer = setTimeout(() => void sample(), delay) }
      }
      void sample()
      const visibility = () => { if (document.hidden) clearTimeout(timer); else void sample() }
      document.addEventListener('visibilitychange', visibility)
      return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
    }, [features.inbox, target, operation, props.revision, running])
    React.useEffect(() => {
      if (!features.options || !open) return
      let live = true
      void operation('options', target).then(v => { if (live) { setOptions(v); setOptionsError(undefined) } }, e => { if (live) { setOptions(undefined); setOptionsError(e) } })
      return () => { live = false }
    }, [features.options, open, target, props.revision, operation])
    const supports = (kind: DimaActionKind) => features.inbox && features.act && !!inbox?.actions.includes(kind)
    const act = async (args: ActionArgs, consumeDraft = false) => {
      if (!operationsReady || !supports(args.kind)) return
      const result = await mutate(() => operation('act', { ...args, ...target, operationId: props.uuid() }), consumeDraft)
      if (!result) return
      if (result.restoredText !== undefined) setDraft([props.getDraft(), result.restoredText].filter(Boolean).join('\n'))
      if (!mounted.current) return
      setLastDetail(result.detail ?? '')
      if (result.newSessionId || result.newBranchId || args.kind === 'setDefault' || args.kind === 'endBranch' || args.kind === 'rename') props.onBranchChange(result)
    }
    const retainedParts = hasParts || props.mediaMemory.items.length > 0
    const canSend = operationsReady && !stopping && (!!draft.trim() || retainedParts)
    const queueReady = canSend && (retainedParts || !props.legacyAvailable ? features.mediaSubmit : legacyReady)
    const hasSteer = supports('steer')
    const steerReady = canSend && hasSteer && (!retainedParts || features.mediaSubmit)
    const showComposer = props.legacyAvailable || features.mediaSubmit || hasSteer || supports('branchCreate') || retainedParts
    const send = async (mode: 'queue' | 'steer') => {
      if (!(mode === 'queue' ? queueReady : steerReady)) return
      if (!retainedParts && mode === 'queue' && legacyReady) return props.submit()
      if (!retainedParts && mode === 'steer') return void act({ kind: 'steer', text: draft }, true)
      if (!features.mediaSubmit) return
      const result = await mutate(async () => {
        const refs = retainedParts ? await prepare.current?.() : []
        if (!mounted.current || !refs || (retainedParts && !refs.length)) throw new Error(t('dimaUnavailable'))
        const items = props.mediaMemory.items
        const receipt = await operation('mediaSubmit', { ...target, requestId: props.uuid(), mode, parts: [...(draft ? [{ type: 'text' as const, text: draft }] : []), ...refs] })
        if (retainedParts && items === props.mediaMemory.items) { props.mediaMemory.items = []; props.mediaMemory.paste = undefined }
        return receipt
      }, true)
      if (result && retainedParts && mounted.current) setResetKey(k => k + 1)
    }
    const button = (label: LocaleKey, action: () => void, disabled = !operationsReady) => h('button', { type: 'button', disabled, onClick: action }, t(label))
    const stopWithDraft = async (sendAfter: boolean) => {
      if (!legacyReady || !running || stopping) return
      if (!features.inbox) { if (!sendAfter) await mutate(props.stop); return }
      await mutate(async () => {
        // Save each confirmed withdrawal to this branch immediately, even if the panel closes.
        const fresh = await operation('inbox', target)
        if (retainedParts || fresh.queue.some(row => !row.editable) || (fresh.queue.length && (!features.act || !fresh.actions.includes('retrieve')))) throw new Error(t('dimaRecoverBlocked'))
        let recovered = ''
        let currentDraft = props.getDraft()
        const ensureCurrent = () => { if (!mounted.current) throw new Error(t('dimaUnavailable')) }
        for (const row of fresh.queue) {
          ensureCurrent()
          let result: DimaActionResult
          try { result = await operation('act', { ...target, kind: 'retrieve', inputId: row.inputId, operationId: props.uuid() }) }
          catch (e) {
            if (e && typeof e === 'object' && (('code' in e && e.code === 'DIMA_INPUT_NOT_HELD') ||
              ('details' in e && (e.details as { remoteCode?: string } | undefined)?.remoteCode === 'DIMA_INPUT_NOT_HELD'))) continue
            throw e
          }
          if (result.restoredText !== undefined) {
            recovered = [recovered, result.restoredText].filter(Boolean).join('\n')
            setDraft([recovered, currentDraft].filter(Boolean).join('\n'))
          }
        }
        ensureCurrent()
        await props.stop()
        if (!sendAfter) return
        ensureCurrent()
        currentDraft = props.getDraft()
        if (!currentDraft.trim()) return
        await props.submitText(currentDraft)
        if (props.getDraft() === currentDraft) setDraft('')
      })
    }
    const canQueue = props.legacyAvailable || features.mediaSubmit
    const primary = hasSteer && (running || !canQueue) ? 'steer' : 'queue'
    const media = features.inbox ? inbox?.media : undefined
    const rich = retainedParts || (features.mediaSubmit && ((features.mediaUpload && (media?.image || media?.paste)) || (features.mediaSearch && media?.file)))
    const models = options?.models ?? []
    const currentModel = models.findIndex(m => m.provider === options?.model?.provider && m.modelId === options?.model?.modelId)
    return h('div', { className: 'dshDimaControls', 'data-dima-composer': true },
      inboxError ? h('p', { role: 'alert' }, messageOf(inboxError, t)) : null,
      features.inbox && inbox?.questions.map(batch => h(Questions, { key: JSON.stringify(batch), batch, ready: operationsReady && supports('answer'), act, t })),
      features.inbox && inbox?.queue.map((q, i) => h('div', { key: q.inputId, className: 'dshDimaQueueRow' }, h('span', null, q.text),
        i === 0 && supports('steerQueued') ? button('dimaSteer', () => void act({ kind: 'steerQueued', inputId: q.inputId })) : null,
        q.editable && supports('retrieve') ? button('dimaRetrieve', () => { if (!draft || window.confirm(t('dimaRetrieveConfirm'))) void act({ kind: 'retrieve', inputId: q.inputId }) }) : null,
        supports('withdraw') ? button('dimaWithdraw', () => void act({ kind: 'withdraw', inputId: q.inputId })) : null)),
      rich ? h(Media, { operation, target, features, lang: props.lang, ready: operationsReady && !stopping, onPrepare, resetKey,
        available: media, memory: props.mediaMemory, connection: props.connection, uuid: props.uuid }) : null,
      showComposer ? h('label', { className: 'dshDimaDraft' }, t('dimaMessage'), h('textarea', { rows: 2, readOnly: !operationsReady || stopping, maxLength: DIMA_MAX_PROMPT_CHARS, value: draft,
        onChange: (e: Event) => setDraft((e.target as HTMLTextAreaElement).value),
        onKeyDown: (e: KeyboardEvent) => { if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return; e.preventDefault(); void send(primary) } })) : null,
      h('div', { className: 'dshRemotePageActions' }, primary === 'steer' || canQueue ? button(primary === 'steer' ? 'dimaSteer' : running ? 'dimaQueue' : 'dimaSend', () => void send(primary), !(primary === 'steer' ? steerReady : queueReady)) : null,
        primary === 'steer' && canQueue ? button('dimaQueue', () => void send('queue'), !queueReady) : null,
        props.legacyAvailable && (running || stopping) ? button('dimaStopBranch', () => void stopWithDraft(false), !legacyReady || stopping) : null,
        props.legacyAvailable && running && features.inbox ? button('dimaStopSend', () => void stopWithDraft(true), !legacyReady || stopping || retainedParts || (!draft.trim() && !inbox?.queue.length)) : null),
      (features.options || (features.act && inbox?.actions.some(k => ['branchCreate', 'fork', 'setDefault', 'endBranch', 'compact', 'rename'].includes(k)))) ? h('details', { onToggle: (e: Event) => setOpen((e.target as HTMLDetailsElement).open) },
        h('summary', null, t('dimaOptions')), open ? h('div', { className: 'dshDimaSettings' },
          optionsError ? h('p', { role: 'alert' }, messageOf(optionsError, t)) : null,
          options?.model ? h('label', null, t('dimaModel'), supports('setModel') && models.length ? h('select', { value: currentModel, disabled: !operationsReady,
            onChange: (e: Event) => { const model = models[Number((e.target as HTMLSelectElement).value)]; if (model) void act({ kind: 'setModel', provider: model.provider, modelId: model.modelId }) } },
            currentModel < 0 ? h('option', { value: -1 }, options.model.modelId) : null, models.map((m, i) => h('option', { key: JSON.stringify([m.provider, m.modelId]), value: i }, m.label))) : h('span', null, options.model.modelId)) : null,
          options?.effort || models[currentModel]?.efforts.length ? h('label', null, t('dimaEffort'), supports('setEffort') && models[currentModel]?.efforts.length ? h('select', { value: options?.effort ?? '', disabled: !operationsReady,
            onChange: (e: Event) => void act({ kind: 'setEffort', effort: (e.target as HTMLSelectElement).value }) },
            !models[currentModel]?.efforts.includes(options?.effort ?? '') ? h('option', { value: options?.effort ?? '' }, options?.effort ?? '—') : null,
            models[currentModel]?.efforts.map(e => h('option', { key: e, value: e }, e))) : options?.effort) : null,
          supports('setAgent') && options?.agents?.length ? h('label', null, t('dimaSelectAgent'), h('select', { value: '', disabled: !operationsReady,
            onChange: (e: Event) => { const agentId = (e.target as HTMLSelectElement).value; if (agentId) void act({ kind: 'setAgent', agentId }) } }, h('option', { value: '' }, '—'),
            options.agents.map(agent => h('option', { value: agent.agentId, key: agent.agentId }, agent.label)))) : null,
          supports('rename') ? button('dimaRename', () => { const title = window.prompt(t('dimaTitlePrompt')); if (title !== null && title.length <= 8192) void act({ kind: 'rename', title: title.trim() || null }) }) : null,
          options?.usage ? h('span', null, t('dimaUsage'), ' ', options.usage.estimatedInputTokens, ' / ', options.usage.contextWindow) : null,
          supports('compact') ? button('dimaCompact', () => void act({ kind: 'compact' })) : null,
          supports('branchCreate') ? button('dimaCreateBranch', () => void act({ kind: 'branchCreate', text: draft }, true), !operationsReady || !draft.trim() || retainedParts) : null,
          supports('fork') ? button('dimaFork', () => void act({ kind: 'fork' })) : null,
          supports('setDefault') ? button('dimaSetDefault', () => void act({ kind: 'setDefault' })) : null,
          supports('endBranch') ? button('dimaEnd', () => { if (window.confirm(t('dimaConfirmEnd', { branch: target.branchId }))) void act({ kind: 'endBranch' }) }) : null) : null) : null,
      features.goal || features.tasks || features.conversationExport ? h(Tasks, { ...props, ready: operationsReady, operation }) : null,
      lastDetail ? h('p', { role: 'status' }, lastDetail) : null)
  }
}
