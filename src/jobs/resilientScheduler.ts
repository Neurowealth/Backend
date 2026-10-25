/**
 * Shared scheduler for recurring maintenance jobs.
 *
 * A failed run is resumed automatically with full-jitter exponential backoff
 * instead of waiting for the next interval (which is hours for several jobs).
 * The next process start also runs each job immediately, so work that was
 * in flight at a crash is picked up again. Overlapping ticks do not start a
 * second run; a tick that arrives mid-run is resumed once the current attempt
 * finishes, unless that attempt already exhausted its retries.
 *
 * Cross-pod safety (#636): each tick first takes a Postgres advisory lock
 * keyed by the job name, so in a multi-replica deployment exactly one pod
 * runs the job per tick. The lock is a `pg_try_advisory_xact_lock` held for
 * the duration of the run and released when the wrapping transaction ends.
 * A tick that loses the lock contest is skipped, not queued.
 */
import { logger } from '../utils/logger'
import { computeBackoffMs } from '../outbox/stateMachine'
import { recordJobCompletion, recordJobRetry } from '../utils/job-metrics'
import db from '../db'

export const JOB_MAX_ATTEMPTS = 3
export const JOB_BACKOFF_BASE_MS = 1_000
export const JOB_BACKOFF_MAX_MS = 30_000

export type JobRunStatus = 'success' | 'failed'

/**
 * Wraps one tick so at most one replica executes the job. The guard simply
 * declines to call `task` when another replica already holds the lock.
 */
export type JobRunGuard = (
  jobName: string,
  task: () => Promise<void>
) => Promise<void>

/**
 * Per-tick cross-pod lock (#636). `pg_try_advisory_xact_lock` is used rather
 * than session-scoped `pg_advisory_lock` because Prisma hands pooled
 * connections back between calls — a session lock would leak across queries.
 * The xact lock is released when the transaction commits or rolls back.
 */
export const withPostgresJobLock: JobRunGuard = async (jobName, task) => {
  await db.$transaction(
    async (tx) => {
      const rows: Array<{ locked: boolean }> = await tx.$queryRaw`
        SELECT pg_try_advisory_xact_lock(hashtext(${jobName})) AS locked
      `
      if (!rows[0]?.locked) {
        logger.info(
          `[JobScheduler] ${jobName} skipped; another replica holds the tick lock`
        )
        return
      }
      await task()
    },
    { timeout: 600_000, maxWait: 2_000 }
  )
}

/** Escape hatch for tests and single-replica local runs. */
export const withoutJobLock: JobRunGuard = (_jobName, task) => task()

export type JobRetryOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  onExhausted?: (error: unknown, attempts: number) => Promise<void> | void
}

type JobSlot = {
  running: boolean
  /** A tick arrived while a run was in flight. Resume once if that run succeeds. */
  resume: boolean
}

const slots = new Map<string, JobSlot>()

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `task` until it resolves or `maxAttempts` is exhausted.
 * Each failed attempt is recorded, then resumed after backoff.
 * Completion status is recorded once, for the terminal outcome.
 */
export async function runJobWithRetry(
  jobName: string,
  task: () => Promise<void>,
  options: JobRetryOptions = {}
): Promise<JobRunStatus> {
  const maxAttempts = options.maxAttempts ?? JOB_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? JOB_BACKOFF_BASE_MS
  const maxDelayMs = options.maxDelayMs ?? JOB_BACKOFF_MAX_MS
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await task()
      recordJobCompletion(jobName, 'success')
      if (attempt > 1) {
        logger.info(`[JobScheduler] ${jobName} resumed after retry`, {
          attempt,
          maxAttempts,
        })
      }
      return 'success'
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) break

      const delayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random)
      recordJobRetry(jobName)
      logger.warn(`[JobScheduler] ${jobName} failed; resuming after backoff`, {
        attempt,
        maxAttempts,
        delayMs,
        error: errorMessage(error),
      })
      await sleep(delayMs)
    }
  }

  recordJobCompletion(jobName, 'failed')
  logger.error(`[JobScheduler] ${jobName} exhausted retries`, {
    attempts: maxAttempts,
    error: errorMessage(lastError),
  })

  if (options.onExhausted) {
    try {
      await options.onExhausted(lastError, maxAttempts)
    } catch (hookError) {
      logger.error(`[JobScheduler] ${jobName} exhaustion hook failed`, {
        error: errorMessage(hookError),
      })
    }
  }

  return 'failed'
}

/**
 * Run `task` immediately (covers a restart after a crash), then on `intervalMs`.
 * Returns the interval handle. Pass it to clearInterval on shutdown.
 */
export function scheduleResilientJob(
  opts: {
    jobName: string
    task: () => Promise<void>
    intervalMs: number
    unref?: boolean
    /**
     * Cross-pod tick guard. Defaults to the Postgres advisory lock outside
     * tests; pass `withoutJobLock` or a custom shared lock in tests.
     */
    guard?: JobRunGuard
  } & JobRetryOptions
): NodeJS.Timeout {
  const slot: JobSlot = { running: false, resume: false }
  slots.set(opts.jobName, slot)
  const guard: JobRunGuard =
    opts.guard ??
    (process.env.NODE_ENV === 'test' ? withoutJobLock : withPostgresJobLock)

  const tick = (): void => {
    if (slot.running) {
      slot.resume = true
      logger.warn(
        `[JobScheduler] ${opts.jobName} still running; will resume when it finishes`
      )
      return
    }

    slot.running = true
    void (async () => {
      try {
        await guard(opts.jobName, async () => {
          do {
            slot.resume = false
            const status = await runJobWithRetry(opts.jobName, opts.task, opts)
            // A terminal failure must wait for the next interval. Honouring
            // resume here would tight-loop a job that is still broken.
            if (status === 'failed') slot.resume = false
          } while (slot.resume)
        })
      } finally {
        slot.running = false
      }
    })()
  }

  tick()
  const handle = setInterval(tick, opts.intervalMs)
  if (opts.unref) handle.unref?.()
  return handle
}
