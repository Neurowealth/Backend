import client from 'prom-client'
import { register } from './metrics-registry'

export const jobSuccessTotal = new client.Counter({
  name: 'job_success_total',
  help: 'Total number of successful background job executions',
  labelNames: ['job_name'] as const,
  registers: [register],
})

export const jobFailureTotal = new client.Counter({
  name: 'job_failure_total',
  help: 'Total number of failed background job executions',
  labelNames: ['job_name'] as const,
  registers: [register],
})

export const jobDurationMs = new client.Histogram({
  name: 'job_duration_ms',
  help: 'Duration of background job executions in milliseconds',
  labelNames: ['job_name'] as const,
  buckets: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000],
  registers: [register],
})

/** 1 after the last run succeeded, 0 after retries were exhausted. */
export const jobCompletionStatus = new client.Gauge({
  name: 'job_completion_status',
  help: 'Terminal status of the last background job run (1 success, 0 failed)',
  labelNames: ['job_name'] as const,
  registers: [register],
})

export const jobRetryTotal = new client.Counter({
  name: 'job_retry_total',
  help: 'Automatic resume attempts after a failed background job run',
  labelNames: ['job_name'] as const,
  registers: [register],
})

/**
 * Thrown by recordJobFailure so a maintenance job cannot swallow a failed
 * attempt. The resilient scheduler catches this and resumes the run.
 */
export class JobFailedError extends Error {
  readonly jobName: string

  constructor(jobName: string, cause?: unknown) {
    const detail =
      cause instanceof Error
        ? cause.message
        : cause
          ? String(cause)
          : 'background job failed'
    super(detail)
    this.name = 'JobFailedError'
    this.jobName = jobName
  }
}

export function recordJobSuccess(jobName: string, durationMs: number): void {
  jobSuccessTotal.inc({ job_name: jobName })
  jobDurationMs.observe({ job_name: jobName }, durationMs)
}

export function recordJobFailure(
  jobName: string,
  durationMs: number,
  error?: unknown
): never {
  jobFailureTotal.inc({ job_name: jobName })
  jobDurationMs.observe({ job_name: jobName }, durationMs)
  throw new JobFailedError(jobName, error)
}

export function recordJobCompletion(
  jobName: string,
  status: 'success' | 'failed'
): void {
  jobCompletionStatus.set({ job_name: jobName }, status === 'success' ? 1 : 0)
}

export function recordJobRetry(jobName: string): void {
  jobRetryTotal.inc({ job_name: jobName })
}

export async function getJobDashboardSnapshot(): Promise<{
  timestamp: string
  jobs: Record<
    string,
    {
      successTotal: number
      failureTotal: number
      retryTotal: number
      lastStatus: 'success' | 'failed' | 'unknown'
    }
  >
}> {
  const json = await register.getMetricsAsJSON()
  const jobMap: Record<
    string,
    {
      successTotal: number
      failureTotal: number
      retryTotal: number
      lastStatus: 'success' | 'failed' | 'unknown'
    }
  > = {}

  const getOrCreate = (name: string) => {
    if (!jobMap[name]) {
      jobMap[name] = {
        successTotal: 0,
        failureTotal: 0,
        retryTotal: 0,
        lastStatus: 'unknown',
      }
    }
    return jobMap[name]
  }

  for (const metric of json) {
    if (metric.name === 'job_success_total') {
      for (const val of metric.values) {
        const job = (val.labels as any).job_name
        if (job) getOrCreate(job).successTotal = val.value
      }
    } else if (metric.name === 'job_failure_total') {
      for (const val of metric.values) {
        const job = (val.labels as any).job_name
        if (job) getOrCreate(job).failureTotal = val.value
      }
    } else if (metric.name === 'job_retry_total') {
      for (const val of metric.values) {
        const job = (val.labels as any).job_name
        if (job) getOrCreate(job).retryTotal = val.value
      }
    } else if (metric.name === 'job_completion_status') {
      for (const val of metric.values) {
        const job = (val.labels as any).job_name
        if (job)
          getOrCreate(job).lastStatus = val.value === 1 ? 'success' : 'failed'
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    jobs: jobMap,
  }
}
