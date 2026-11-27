import type { DimaFeatures, DimaHistoryRequest, DimaOperation, DimaOperationRequest, DimaOperationResult, DimaTaskRequest, DimaTaskResult } from '@dsh-remote/protocol'
import type { ClientReact } from './types.js'

const words = {
  en: { goal: 'Branch goal', tasks: 'Session tasks', details: 'Details', stop: 'Stop', cancel: 'Cancel', update: 'Set goal', edit: 'Edit goal', pause: 'Pause', resume: 'Resume', clear: 'Clear', export: 'Export main branch', empty: 'No tasks', none: 'No goal', truncated: 'Only part of the output is shown.' },
  zh: { goal: '分支目标', tasks: '会话任务', details: '详情', stop: '停止', cancel: '取消', update: '设置目标', edit: '修改目标', pause: '暂停', resume: '继续', clear: '清除', export: '导出主分支', empty: '暂无任务', none: '暂无目标', truncated: '仅显示部分输出。' },
  ru: { goal: 'Цель ветви', tasks: 'Задачи сеанса', details: 'Подробнее', stop: 'Остановить', cancel: 'Отмена', update: 'Задать цель', edit: 'Изменить цель', pause: 'Приостановить', resume: 'Продолжить', clear: 'Очистить', export: 'Экспорт основной ветви', empty: 'Задач нет', none: 'Цели нет', truncated: 'Показана часть вывода.' },
  uk: { goal: 'Мета гілки', tasks: 'Завдання сеансу', details: 'Подробиці', stop: 'Зупинити', cancel: 'Скасувати', update: 'Задати мету', edit: 'Змінити мету', pause: 'Призупинити', resume: 'Продовжити', clear: 'Очистити', export: 'Експорт головної гілки', empty: 'Немає завдань', none: 'Немає мети', truncated: 'Показано частину виводу.' },
}
type Props = {
  target: DimaHistoryRequest; features: DimaFeatures; lang: keyof typeof words; ready: boolean; refresh: () => void; uuid: () => string
  operation: <K extends DimaOperation>(key: K, request: DimaOperationRequest<K>) => Promise<DimaOperationResult<K>>
  mutate: <T>(work: () => Promise<T>) => Promise<T | undefined>
}
export function createDimaTasks(React: ClientReact) {
  const h = React.createElement
  function Panel({ target: { sessionId, branchId }, features, lang, ready, operation, mutate, refresh, uuid }: Props) {
    const t = words[lang], branch = { sessionId, branchId }
    const [goal, setGoal] = React.useState<DimaTaskResult<'goal'>['goal'] | undefined>(undefined)
    const [items, setItems] = React.useState<DimaTaskResult<'tasks'>['items'] | undefined>(undefined)
    const [detail, setDetail] = React.useState<DimaTaskResult<'taskDetail'> | undefined>(undefined)
    const [confirmStop, setConfirmStop] = React.useState<string | undefined>(undefined)
    const [objective, setObjective] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
    const active = React.useRef(false), lock = React.useRef(false)
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect
    useLayoutEffect(() => { active.current = true; return () => { active.current = false } }, [])
    async function run(work: () => Promise<void>) {
      if (!ready || lock.current) return
      lock.current = true; setBusy(true); setError('')
      try { await work() } catch (e) { if (active.current) setError(e instanceof Error ? e.message : String(e)) }
      finally { lock.current = false; if (active.current) setBusy(false) }
    }
    function button(label: string, work: () => Promise<void>, disabled = false) {
      return h('button', { type: 'button', disabled: !ready || busy || disabled, onClick: () => void run(work) }, label)
    }
    async function loadGoal() {
      const value = await operation('goal', branch)
      if (active.current) { setGoal(value.goal); setObjective(value.goal?.objective ?? '') }
    }
    async function loadTasks() {
      const value = await operation('tasks', branch)
      if (active.current) { setItems(value.items); setDetail(undefined); setConfirmStop(undefined) }
    }
    async function change(action: DimaTaskRequest<'goalUpdate'>['action']) {
      const operationId = uuid()
      const request = action === 'set' || action === 'edit' ? { ...branch, action, operationId, objective } : { ...branch, action, operationId }
      const value = await mutate(() => operation('goalUpdate', request))
      if (active.current && value) { setGoal(value.goal); setObjective(value.goal?.objective ?? ''); refresh() }
    }
    async function download(format: 'markdown' | 'json') {
      const value = await operation('conversationExport', { sessionId, branchId: 'main', format })
      if (!active.current) return
      const link = document.createElement('a'), url = URL.createObjectURL(new Blob([value.text], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' }))
      link.href = url; link.download = 'session-' + uuid() + (format === 'json' ? '.json' : '.md')
      try { link.click() } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    }
    return h('section', { className: 'dshRemoteDimaTasks' },
      features.goal ? button(t.goal, loadGoal) : null,
      goal !== undefined ? h('div', null, h('p', null, goal ? [goal.status, goal.objective, goal.reason].filter(Boolean).join(' · ') : t.none),
        features.goalUpdate ? h('div', null,
          h('textarea', { 'aria-label': t.goal, value: objective, maxLength: 8000, onChange: (e: { target: { value: string } }) => setObjective(e.target.value) }),
          button(goal && ['active','paused'].includes(goal.status) ? t.edit : t.update, () => change(goal && ['active','paused'].includes(goal.status) ? 'edit' : 'set'), !objective.trim() || [...objective].length > 4000),
          goal?.status === 'active' ? button(t.pause, () => change('pause')) : null,
          goal?.status === 'paused' ? button(t.resume, () => change('resume')) : null,
          goal ? button(t.clear, () => change('clear')) : null) : null) : null,
      features.tasks ? button(t.tasks, loadTasks) : null,
      items?.length === 0 ? h('p', null, t.empty) : null,
      ...((items ?? []).map(item => h('div', { key: JSON.stringify(item.target) }, h('span', null, [item.target.branchId, item.target.kind, item.label, item.target.id, item.state].join(' · ')),
        features.taskDetail ? button(t.details, async () => { const value = await operation('taskDetail', { ...branch, target: item.target }); if (active.current) setDetail(value) }) : null,
        features.taskStop && item.canStop ? (confirmStop === JSON.stringify(item.target)
          ? h('div', null, button(t.stop + ' · ' + item.target.id, async () => {
            setConfirmStop(undefined)
            const value = await mutate(() => operation('taskStop', { ...branch, target: item.target, operationId: uuid() }))
            if (active.current && value) { await loadTasks(); refresh() }
          }), button(t.cancel, async () => setConfirmStop(undefined)))
          : button(t.stop, async () => setConfirmStop(JSON.stringify(item.target)))) : null,
        detail && detail.target.branchId === item.target.branchId && detail.target.kind === item.target.kind && detail.target.id === item.target.id ? h('pre', null, detail.text, detail.truncated ? '\n' + t.truncated : '') : null))),
      features.conversationExport ? h('div', null, button(t.export + ' · Markdown', () => download('markdown')), button(t.export + ' · JSON', () => download('json'))) : null,
      error ? h('p', { role: 'alert' }, error) : null)
  }
  return (props: Props) => h(Panel, { key: JSON.stringify(props.target), ...props })
}
