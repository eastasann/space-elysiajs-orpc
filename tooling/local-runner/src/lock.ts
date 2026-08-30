import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/**
 * Single-runner mutual exclusion.
 *
 * Two runners on one machine would claim the same issue, create the same
 * worktree and push the same branch. GitHub's own concurrency groups protect
 * the control plane; nothing protects a developer's laptop except this.
 */

export const lockFileSchema = z.object({
  pid: z.number().int().positive(),
  /** Hostname, so a lock left behind by another machine is obvious. */
  host: z.string(),
  startedAt: z.string(),
  command: z.string(),
})
export type LockFile = z.infer<typeof lockFileSchema>

export type AcquireOutcome =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; reason: string; holder?: LockFile }

export interface LockOptions {
  /** Overridden in tests; defaults to a real `kill(pid, 0)` liveness probe. */
  isRunning?: (pid: number) => boolean
  host?: string
  pid?: number
  now?: () => Date
}

function defaultIsRunning(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. EPERM means the process exists but belongs to someone else.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take the lock, or explain who holds it.
 *
 * A lock whose owner is gone is stale and is taken over, but only when the
 * hostname matches: a PID from another machine says nothing about this one, so
 * that case needs a human rather than a guess.
 */
export async function acquireLock(
  path: string,
  command: string,
  options: LockOptions = {},
): Promise<AcquireOutcome> {
  const isRunning = options.isRunning ?? defaultIsRunning
  const host = options.host ?? Bun.env.HOSTNAME ?? 'localhost'
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())

  await mkdir(dirname(path), { recursive: true })

  const existing = await readLock(path)
  if (existing !== null) {
    if (existing.host !== host) {
      return {
        acquired: false,
        holder: existing,
        reason: `The lock is held by ${existing.host} (pid ${existing.pid}). This machine cannot tell whether that runner is still alive; check it, then delete ${path}.`,
      }
    }
    if (isRunning(existing.pid)) {
      return {
        acquired: false,
        holder: existing,
        reason: `Another runner is already going (pid ${existing.pid}, started ${existing.startedAt}).`,
      }
    }
    // Stale: same host, dead pid.
  }

  const lock: LockFile = { pid, host, startedAt: now().toISOString(), command }
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  return {
    acquired: true,
    release: async () => {
      const current = await readLock(path)
      // Only release our own lock: a runner that was killed and whose lock was
      // taken over must not delete the new owner's.
      if (current?.pid === pid && current.host === host) await rm(path, { force: true })
    },
  }
}

export async function readLock(path: string): Promise<LockFile | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }

  try {
    const parsed = lockFileSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
