import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { dimaExtensionPolicySchema, type DimaExtensionGrant } from '../config.js'

const maxPolicyBytes = 64 * 1024
const policyName = 'dima-extension-grants.json'
const policyHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** Even if an owner opens the Host credentials directory as a workspace, uploads cannot create policy. */
export function isDimaPolicyUpload(name: string, directory: { dev: number; ino: number }): boolean {
  if (name.toLowerCase() !== policyName) return false
  try {
    const root = lstatSync(join(policyHome(), 'ds-harness-remote'))
    return root.isDirectory() && directory.dev === root.dev && directory.ino === root.ino
  } catch (error) {
    // A missing policy directory cannot be this existing upload destination.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** Read at the mutation boundary; no RPC, client input, or settings object selects this location. */
export function readDimaExtensionGrants(): readonly DimaExtensionGrant[] {
  let descriptor: number | undefined
  try {
    const home = policyHome()
    if (!isAbsolute(home)) return []
    const root = join(home, 'ds-harness-remote')
    const file = join(root, policyName)
    const uid = process.geteuid?.()
    for (const dir of [home, root]) {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0))) return []
    }
    const entry = lstatSync(file, { bigint: true })
    if (!entry.isFile() || entry.nlink !== 1n || entry.size > BigInt(maxPolicyBytes)) return []
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1n
      || opened.size !== entry.size || (uid !== undefined && (opened.uid !== BigInt(uid) || (opened.mode & 0o022n) !== 0n))) return []
    const buffer = Buffer.alloc(Number(opened.size) + 1)
    let count = 0
    while (count < buffer.length) {
      const bytes = readSync(descriptor, buffer, count, buffer.length - count, count)
      if (!bytes) break
      count += bytes
    }
    const current = lstatSync(file, { bigint: true })
    if (count !== Number(opened.size) || current.dev !== opened.dev || current.ino !== opened.ino
      || current.ctimeNs !== opened.ctimeNs || current.size !== opened.size) return []
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))
    return dimaExtensionPolicySchema.parse(JSON.parse(text)).grants
  } catch {
    return []
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
