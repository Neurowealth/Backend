const mockSuccessInc = jest.fn()
const mockFailureInc = jest.fn()
const mockRetryInc = jest.fn()
const mockObserve = jest.fn()
const mockGaugeSet = jest.fn()

jest.mock('prom-client', () => {
  let counterCallCount = 0
  const Counter = jest.fn().mockImplementation(() => {
    counterCallCount++
    if (counterCallCount === 1) return { inc: mockSuccessInc }
    if (counterCallCount === 2) return { inc: mockFailureInc }
    return { inc: mockRetryInc }
  })
  const Histogram = jest
    .fn()
    .mockImplementation(() => ({ observe: mockObserve }))
  const Gauge = jest.fn().mockImplementation(() => ({ set: mockGaugeSet }))
  const Registry = jest.fn().mockImplementation(() => ({
    registerMetric: jest.fn(),
    resetMetrics: jest.fn(),
    metrics: jest.fn().mockResolvedValue(''),
    setDefaultLabels: jest.fn(),
  }))
  return {
    __esModule: true,
    default: {
      Counter,
      Histogram,
      Gauge,
      Registry,
      register: {
        registerMetric: jest.fn(),
        resetMetrics: jest.fn(),
        metrics: jest.fn().mockResolvedValue(''),
        setDefaultLabels: jest.fn(),
        collectDefaultMetrics: jest.fn(),
      },
    },
    collectDefaultMetrics: jest.fn(),
    register: {
      registerMetric: jest.fn(),
      resetMetrics: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
      setDefaultLabels: jest.fn(),
    },
    Registry,
    Counter,
    Histogram,
    Gauge,
  }
})

jest.mock('../../../src/utils/metrics-registry', () => ({
  register: {
    registerMetric: jest.fn(),
    resetMetrics: jest.fn(),
    metrics: jest.fn().mockResolvedValue(''),
    setDefaultLabels: jest.fn(),
  },
}))

import {
  recordJobSuccess,
  recordJobFailure,
  recordJobCompletion,
  recordJobRetry,
  JobFailedError,
} from '../../../src/utils/job-metrics'

describe('job-metrics', () => {
  beforeEach(() => {
    mockSuccessInc.mockClear()
    mockFailureInc.mockClear()
    mockRetryInc.mockClear()
    mockObserve.mockClear()
    mockGaugeSet.mockClear()
  })

  describe('recordJobSuccess', () => {
    it('increments job_success_total with the correct job_name label', () => {
      recordJobSuccess('session_cleanup', 250)
      expect(mockSuccessInc).toHaveBeenCalledWith({
        job_name: 'session_cleanup',
      })
    })

    it('observes job_duration_ms with the correct job_name label and duration', () => {
      recordJobSuccess('retention_auth_nonces', 450)
      expect(mockObserve).toHaveBeenCalledWith(
        { job_name: 'retention_auth_nonces' },
        450
      )
    })

    it('does not call inc on the failure counter', () => {
      mockSuccessInc.mockClear()
      mockFailureInc.mockClear()
      recordJobSuccess('retention_agent_logs', 100)
      expect(mockSuccessInc).toHaveBeenCalledWith({
        job_name: 'retention_agent_logs',
      })
      expect(mockFailureInc).not.toHaveBeenCalled()
    })
  })

  describe('recordJobFailure', () => {
    it('increments job_failure_total and throws so the scheduler can resume', () => {
      expect(() => recordJobFailure('session_cleanup', 300)).toThrow(
        JobFailedError
      )
      expect(mockFailureInc).toHaveBeenCalledWith({
        job_name: 'session_cleanup',
      })
    })

    it('observes job_duration_ms with the correct job_name label and duration', () => {
      expect(() =>
        recordJobFailure('retention_processed_events', 750, new Error('db'))
      ).toThrow('db')
      expect(mockObserve).toHaveBeenCalledWith(
        { job_name: 'retention_processed_events' },
        750
      )
    })

    it('does not call inc on the success counter', () => {
      mockSuccessInc.mockClear()
      mockFailureInc.mockClear()
      expect(() =>
        recordJobFailure('retention_dead_letter_events', 200)
      ).toThrow(JobFailedError)
      expect(mockFailureInc).toHaveBeenCalledWith({
        job_name: 'retention_dead_letter_events',
      })
      expect(mockSuccessInc).not.toHaveBeenCalled()
    })
  })

  describe('recordJobCompletion', () => {
    it('sets job_completion_status to 1 on success and 0 on failure', () => {
      recordJobCompletion('session_cleanup', 'success')
      recordJobCompletion('session_cleanup', 'failed')
      expect(mockGaugeSet).toHaveBeenNthCalledWith(
        1,
        { job_name: 'session_cleanup' },
        1
      )
      expect(mockGaugeSet).toHaveBeenNthCalledWith(
        2,
        { job_name: 'session_cleanup' },
        0
      )
    })
  })

  describe('recordJobRetry', () => {
    it('increments job_retry_total for the job that will be resumed', () => {
      recordJobRetry('referral_payout')
      expect(mockRetryInc).toHaveBeenCalledWith({ job_name: 'referral_payout' })
      expect(mockFailureInc).not.toHaveBeenCalled()
    })
  })
})
