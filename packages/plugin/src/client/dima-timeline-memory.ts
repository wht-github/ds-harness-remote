import type { DimaTimeline } from '@dsh-remote/protocol'

export type ReadingAnchor = { turnId: string; sequence: number; blockId?: string; top: number }

export class DimaTimelineReading {
  page?: DimaTimeline
  anchor?: ReadingAnchor
  readonly expanded = new Map<string, boolean>()
  retryAt = 0
  retryDelay = 0

  constructor(readonly host: string, readonly observeDaemon: (instanceId: string) => void) {}

  setExpanded(key: string, open: boolean) {
    this.expanded.delete(key)
    if (this.expanded.size >= 512) this.expanded.delete(this.expanded.keys().next().value!)
    this.expanded.set(key, open)
  }

  clear() {
    this.page = undefined
    this.anchor = undefined
    this.expanded.clear()
    this.retryAt = this.retryDelay = 0
  }
}

/** Only validated, in-memory branch windows are retained. Rendering waits for a new daemon receipt on re-entry. */
export class DimaTimelineMemory {
  private readonly branches = new Map<string, DimaTimelineReading>()

  forBranch(host: string, branch: string): DimaTimelineReading {
    const key = JSON.stringify([host, branch])
    const reading = this.branches.get(key) ?? new DimaTimelineReading(host, instanceId => {
      for (const entry of this.branches.values()) {
        if (entry.host === host && entry.page && entry.page.instanceId !== instanceId) entry.clear()
      }
    })
    this.branches.delete(key)
    if (this.branches.size >= 6) this.branches.delete(this.branches.keys().next().value!)
    this.branches.set(key, reading)
    return reading
  }
}
