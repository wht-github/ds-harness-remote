import { createHash } from 'node:crypto'
import {
  dimaExtensionSchema, type DimaExtension, type DimaExtensions, type DimaSetExtensionRequest, type DimaSetExtensionResult,
} from '@dsh-remote/protocol'
import { z } from 'zod'
import type { DimaExtensionGrant } from '../config.js'
import { RpcError } from '../safe-error.js'
import { invalidReply, tooLarge, unknownOutcome } from './native-rpc.js'

export const extensionsNativeMethods = [
  'plugin.list', 'plugin.enable', 'plugin.disable', 'skills.catalog', 'skills.set_enabled', 'mcp.catalog', 'mcp.set_enabled',
] as const
type Method = typeof extensionsNativeMethods[number]
type Reader = { call(method: Method, params: Record<string, unknown>): Promise<unknown> }
type Grants = () => readonly DimaExtensionGrant[]
type Kind = DimaExtension['kind']
const inventories = { plugin: 'plugin.list', skill: 'skills.catalog', mcp: 'mcp.catalog' } as const
const kinds = ['plugin', 'skill', 'mcp'] as const

export function extensionOperations(features: readonly string[]): ('extensions' | 'setExtension')[] {
  if (!kinds.some(kind => features.includes(inventories[kind]))) return []
  const writable = (features.includes('plugin.list') && (features.includes('plugin.enable') || features.includes('plugin.disable')))
    || (features.includes('skills.catalog') && features.includes('skills.set_enabled'))
    || (features.includes('mcp.catalog') && features.includes('mcp.set_enabled'))
  return writable ? ['extensions', 'setExtension'] : ['extensions']
}

// Only projected identity and switch fields leave the Host. A native project Skill ID
// includes its root, but file paths, acquisition details and MCP settings stay local.
const word = dimaExtensionSchema.shape.id
const plugins = z.array(z.object({ name: word, use: word.nullable(), off: z.boolean(), locked: z.boolean(),
  candidates: z.array(z.object({ id: word, kinds: z.array(z.string()).optional(), source: z.unknown().optional() })),
}))
const skills = z.object({ entries: z.array(z.object({ id: word, name: word, source: word, enabled: z.boolean(),
  filePath: z.string(), shadowedBy: word.nullable(),
})) })
const mcpIdentity = z.object({ id: word, source: z.enum(['project', 'plugin', 'user']) })
const mcp = z.object({
  userRevision: word, projectRevision: word.nullable(), servers: z.array(mcpIdentity.extend({ enabled: z.boolean() })),
  invalid: z.array(mcpIdentity),
})
function native<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidReply()
  return result.data
}

type NativeRow = Omit<DimaExtension, 'canToggle'> & { writable: boolean; expectedVersion?: string }
const digest = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const stale = () => new RpcError('DIMA_EXTENSION_STALE', 'Refresh the installed items and review this change again.')

async function rows(rpc: Reader, features: readonly string[], cwd: string, kind: Kind): Promise<NativeRow[]> {
  if (!features.includes(inventories[kind])) return []
  if (kind === 'plugin') {
    const list = native(plugins, await rpc.call('plugin.list', {}))
    // The native switch acts on the logical name and keeps its chosen implementation.
    // Optional offers have zero candidates; no implementation is installed for them.
    return list.filter(row => row.candidates.length > 0).map(row => {
      // Without a selected implementation, an on-name cannot be enabled by name alone.
      const enabled = row.off ? false : row.use === null ? null : true
      return { kind, id: row.name, name: row.name, source: 'plugin', scope: 'host', enabled,
        writable: enabled !== null && !row.locked && features.includes(enabled ? 'plugin.disable' : 'plugin.enable'),
        revision: digest([cwd, kind, row]),
      }
    })
  }
  if (kind === 'skill') {
    const list = native(skills, await rpc.call('skills.catalog', { cwd }))
    return list.entries.map(row => {
      if (row.source !== 'project' && row.source !== 'user' && !row.source.startsWith('plugin:')) throw invalidReply()
      // disabledSkillIds is user-level. Native workspace IDs include the project's skill root;
      // user/plugin IDs are shared across workspaces. Shadowing does not change enabledness.
      return { kind, id: row.id, name: row.name, source: row.source, scope: row.source === 'project' ? 'workspace' : 'host',
        enabled: row.enabled, writable: features.includes('skills.set_enabled'), revision: digest([cwd, kind, row]),
      }
    })
  }
  const list = native(mcp, await rpc.call('mcp.catalog', { cwd }))
  return [...list.servers, ...list.invalid.map(row => ({ ...row, enabled: null }))].map(row => {
    const expectedVersion = row.source === 'project' ? list.projectRevision : row.source === 'user' ? list.userRevision : undefined
    if (row.source === 'project' && !expectedVersion) throw invalidReply()
    return { kind, id: row.id, name: row.id, source: row.source, scope: row.source === 'project' ? 'workspace' : 'host',
      enabled: row.enabled, writable: row.enabled !== null && Boolean(expectedVersion) && features.includes('mcp.set_enabled'),
      expectedVersion: expectedVersion ?? undefined, revision: digest([cwd, kind, row, expectedVersion]),
    }
  })
}

function view({ writable, expectedVersion: _version, ...item }: NativeRow, cwd: string, grants: readonly DimaExtensionGrant[]): DimaExtension {
  const canToggle = writable && grants.some(grant => grant.kind === item.kind && grant.id === item.id && grant.source === item.source
    && grant.cwd === (item.scope === 'workspace' ? cwd : undefined))
  return { ...item, nativeToggleSupported: writable, canToggle }
}

export async function listExtensions(rpc: Reader, features: readonly string[], cwd: string, readGrants: Grants): Promise<DimaExtensions> {
  const all: NativeRow[] = []
  // A NativeRpc connection reads ordered replies, so catalogs must run sequentially.
  for (const kind of kinds) {
    const group = await rows(rpc, features, cwd, kind)
    if (all.length + group.length > 4096) throw tooLarge()
    all.push(...group)
  }
  if (new Set(all.map(row => JSON.stringify([row.kind, row.source, row.id]))).size !== all.length) throw invalidReply()
  const grants = readGrants()
  const items = all.map(row => view(row, cwd, grants))
  if (Buffer.byteLength(JSON.stringify(items)) > 2 * 1024 * 1024) throw tooLarge()
  return { cwd, items }
}

export async function setExtension(rpc: Reader, features: readonly string[], cwd: string, input: DimaSetExtensionRequest, readGrants: Grants): Promise<DimaSetExtensionResult> {
  if (input.cwd !== cwd) throw stale()
  const selected = async () => {
    const list = await rows(rpc, features, cwd, input.kind)
    const matches = list.filter(row => row.id === input.id && row.source === input.source && row.scope === input.scope)
    if (matches.length !== 1) throw stale()
    return matches[0]!
  }
  const before = await selected()
  if (before.revision !== input.revision || before.enabled === input.enabled) throw stale()
  // No await between this fresh local policy read and dispatch of the fixed native method.
  if (!view(before, cwd, readGrants()).canToggle) throw new RpcError('PERMISSION_DENIED', 'The Host does not allow this installed item to be toggled remotely.')
  try {
    if (input.kind === 'plugin') await rpc.call(input.enabled ? 'plugin.enable' : 'plugin.disable', { name: before.id })
    else if (input.kind === 'skill') await rpc.call('skills.set_enabled', { cwd, id: before.id, enabled: input.enabled })
    else await rpc.call('mcp.set_enabled', { cwd, id: before.id, source: before.source, expectedVersion: before.expectedVersion, enabled: input.enabled })
  } catch (error) {
    if (error instanceof RpcError && error.code === 'DIMA_REQUEST_FAILED') throw error
    throw unknownOutcome()
  }
  try {
    const after = await selected()
    if (after.enabled !== input.enabled) throw unknownOutcome()
    return { cwd, operationId: input.operationId, item: view(after, cwd, readGrants()) }
  } catch { throw unknownOutcome() }
}
