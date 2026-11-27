import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dimaSetExtensionRequestSchema, type DimaExtension } from '@dsh-remote/protocol'
import { dimaExtensionPolicySchema, resolveConfig, type DimaExtensionGrant } from '../src/config.js'
import { extensionOperations, extensionsNativeMethods, listExtensions, setExtension } from '../src/dima/extensions.js'
import { readDimaExtensionGrants } from '../src/dima/extensions-policy.js'
import { WorkspaceUploadHost } from '../src/workspace-upload.js'

const cwd = '/known/workspace'
const projectId = 'workspace:/known/workspace/.agents/skills:review'
const all = extensionsNativeMethods
const grant = ({ kind, source, id, scope }: DimaExtension): DimaExtensionGrant => ({ kind, source, id, ...(scope === 'workspace' ? { cwd } : {}) })
const request = ({ kind, id, source, scope, revision, enabled }: DimaExtension) => ({ kind, id, source, scope, revision, enabled: !enabled, cwd, operationId: randomUUID() })

function daemon() {
  const plugin = { name: 'tools', use: 'default' as string | null, off: false, locked: false, candidates: [{ id: 'default', source: { path: 'private-source' } }] }
  const skill = { id: projectId, name: 'review', source: 'project', filePath: 'private-file', enabled: true, shadowedBy: null }
  const mcp = { id: 'review', source: 'project', enabled: false, referencedVariables: ['private-variable'] }
  const state = { revision: 'native-project-revision', failReadback: false, disconnectAfterWrite: false }
  const call = vi.fn(async (method: typeof all[number], params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'plugin.list': return [plugin, { ...plugin, candidates: [], name: 'optional' }, { ...plugin, name: 'locked', locked: true },
        { ...plugin, name: 'missing-choice', off: false, use: null }]
      case 'skills.catalog': return { entries: [skill, { ...skill, name: 'shared', id: 'plugin:test:shared', source: 'plugin:test' }], version: 1, issues: [] }
      case 'mcp.catalog': {
        if (state.failReadback) throw new Error('Native connection closed')
        return { userRevision: 'native-user', projectRevision: state.revision,
          servers: [mcp, { ...mcp, source: 'plugin' }, { ...mcp, source: 'user' }], invalid: [{ ...mcp, id: 'broken', error: 'private-diagnostic' }] }
      }
      case 'plugin.disable': plugin.off = true; plugin.use = null; return {}
      case 'plugin.enable': plugin.off = false; plugin.use = 'default'; return { status: 'active' }
      case 'skills.set_enabled': skill.enabled = Boolean(params.enabled); return { version: 2 }
      case 'mcp.set_enabled': mcp.enabled = Boolean(params.enabled); state.revision = 'next'; state.failReadback = state.disconnectAfterWrite; return { revision: 'next' }
    }
  })
  return { rpc: { call }, state, call }
}

describe('native DimAgent extension authority', () => {
  it('negotiates each catalog separately, omits uninstalled offers and strips raw configuration', async () => {
    const f = daemon()
    expect(extensionOperations(['plugin.enable'])).toEqual([])
    expect(extensionOperations(['plugin.list'])).toEqual(['extensions'])
    const get = () => listExtensions(f.rpc, all, cwd, () => grants)
    let grants: DimaExtensionGrant[] = []
    const initial = await get()
    expect(initial.items.every(row => !row.canToggle)).toBe(true)
    grants = initial.items.map(grant)
    const { items } = await get()
    expect(items.find(row => row.id === 'optional')).toBeUndefined()
    expect(items.find(row => row.id === 'missing-choice')).toMatchObject({ enabled: null, nativeToggleSupported: false, canToggle: false })
    expect(items.find(row => row.id === 'tools')).toMatchObject({ scope: 'host', canToggle: true })
    expect(items.find(row => row.id === 'locked')).toMatchObject({ nativeToggleSupported: false, canToggle: false })
    expect(initial.items.find(row => row.id === 'tools')).toMatchObject({ nativeToggleSupported: true, canToggle: false })
    expect(items.find(row => row.id === 'broken')).toMatchObject({ enabled: null, canToggle: false })
    expect(items.find(row => row.kind === 'mcp' && row.source === 'plugin')).toMatchObject({ scope: 'host', canToggle: false })
    expect(items.find(row => row.id === projectId)).toMatchObject({ scope: 'workspace', canToggle: true })
    expect(items.find(row => row.source === 'plugin:test')).toMatchObject({ scope: 'host', canToggle: true })
    expect(JSON.stringify(items)).not.toContain('private-')
    expect((await listExtensions(f.rpc, ['mcp.catalog'], cwd, () => grants)).items.every(row => row.kind === 'mcp' && !row.canToggle)).toBe(true)
  })

  it('sends only native name/ID switches, checks revisions and reads actual resulting state', async () => {
    const f = daemon()
    const entries = (await listExtensions(f.rpc, all, cwd, () => [])).items
    const grants = () => entries.map(grant)
    const plugin = entries.find(row => row.id === 'tools')!
    for (const initial of [plugin, entries.find(row => row.id === projectId)!, entries.find(row => row.kind === 'mcp' && row.source === 'project' && row.id === 'review')!]) {
      const action = request(initial)
      const result = await setExtension(f.rpc, all, cwd, action, grants)
      expect(result).toMatchObject({ operationId: action.operationId, cwd, item: { scope: initial.scope, enabled: action.enabled } })
      expect(result.item.revision).not.toBe(initial.revision)
      await expect(setExtension(f.rpc, all, cwd, action, grants)).rejects.toMatchObject({ code: 'DIMA_EXTENSION_STALE' })
      if (initial.kind === 'plugin') await setExtension(f.rpc, all, cwd, request(result.item), grants)
    }
    expect(f.call.mock.calls.filter(([method]) => !method.endsWith('catalog') && method !== 'plugin.list')).toEqual([
      ['plugin.disable', { name: 'tools' }], ['plugin.enable', { name: 'tools' }],
      ['skills.set_enabled', { cwd, id: projectId, enabled: false }],
      ['mcp.set_enabled', { cwd, source: 'project', id: 'review', enabled: true, expectedVersion: 'native-project-revision' }],
    ])
  })

  it('refuses removed grants, wrong sources/workspaces, stale revisions and unsupported native directions', async () => {
    const f = daemon()
    const entries = (await listExtensions(f.rpc, all, cwd, () => [])).items
    const selected = entries.find(row => row.kind === 'mcp' && row.source === 'project' && row.id === 'review')!
    const action = request(selected)
    for (const grants of [[], [{ ...grant(selected), source: 'user' }], [{ ...grant(selected), cwd: '/other' }]]) {
      await expect(setExtension(f.rpc, all, cwd, action, () => grants)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }
    await expect(setExtension(f.rpc, ['mcp.catalog'], cwd, action, () => [grant(selected)])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    f.state.revision = 'concurrent-change'
    await expect(setExtension(f.rpc, all, cwd, action, () => [grant(selected)])).rejects.toMatchObject({ code: 'DIMA_EXTENSION_STALE' })
    expect(f.call.mock.calls.every(([method]) => method.endsWith('catalog') || method === 'plugin.list')).toBe(true)
    expect(dimaSetExtensionRequestSchema.safeParse({ ...action, grants: [grant(selected)], use: 'other' }).success).toBe(false)
    f.state.revision = 'native-project-revision'
    f.state.disconnectAfterWrite = true
    await expect(setExtension(f.rpc, all, cwd, action, () => [grant(selected)])).rejects.toMatchObject({ code: 'DIMA_OUTCOME_UNKNOWN' })
    expect(f.call.mock.calls.filter(([method]) => method === 'mcp.set_enabled')).toHaveLength(1)
  })
})

describe('physical Host extension policy', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('reads the fixed local file anew, rejects links and oversize or malformed policies, and isolates Host settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dim-grants-'))
    try {
      vi.stubEnv('DSH_HOME', home)
      const root = join(home, 'ds-harness-remote')
      const file = join(root, 'dima-extension-grants.json')
      const grants = [{ kind: 'skill', id: 'user:review', source: 'user' }]
      const json = JSON.stringify({ grants })
      expect(readDimaExtensionGrants()).toEqual([])
      await mkdir(root, { mode: 0o700 })
      const ordinary = new WorkspaceUploadHost(async () => home)
      const protectedDir = new WorkspaceUploadHost(async () => root)
      try {
        const params = { sessionId: 'fixture', uploadId: randomUUID(), name: 'dima-extension-grants.json', totalBytes: 0 }
        await expect(protectedDir.call('workspace.upload.open', params)).rejects.toMatchObject({ code: 'UPLOAD_INVALID_NAME' })
        await expect(ordinary.call('workspace.upload.open', params)).resolves.toHaveProperty('uploadId', params.uploadId)
        await expect(protectedDir.call('workspace.upload.open', { ...params, name: 'notes.json' })).resolves.toHaveProperty('uploadId', params.uploadId)
      } finally { await Promise.all([ordinary.closeAll(), protectedDir.closeAll()]) }
      await writeFile(file, json, { mode: 0o600 })
      expect(readDimaExtensionGrants()).toEqual(grants)
      expect(dimaExtensionPolicySchema.safeParse({ grants: [{ ...grants[0], source: 'project' }] }).success).toBe(false)
      expect(dimaExtensionPolicySchema.safeParse({ grants: [{ ...grants[0], cwd }] }).success).toBe(false)
      expect(() => resolveConfig({ dima: { enabled: true, extensionGrants: grants } } as never, {})).toThrow()
      await link(file, join(root, 'alias'))
      expect(readDimaExtensionGrants()).toEqual([])
      await rm(join(root, 'alias'))
      await writeFile(file, json + ' '.repeat(65536))
      expect(readDimaExtensionGrants()).toEqual([])
      await writeFile(file, '<invalid>')
      expect(readDimaExtensionGrants()).toEqual([])
      await writeFile(file, '{"grants":[]}')
      expect(readDimaExtensionGrants()).toEqual([])
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
