const mockSuccessInc = jest.fn()
const mockFailureInc = jest.fn()
const mockObserve = jest.fn()

jest.mock('prom-client', () => {
  let counterCallCount = 0
  return {
    __esModule: true,
    default: {
      Counter: jest.fn().mockImplementation(() => {
        counterCallCount++
        if (counterCallCount === 1) return { inc: mockSuccessInc }
        return { inc: mockFailureInc }
      }),
      Histogram: jest.fn().mockImplementation(() => ({ observe: mockObserve })),
      Registry: jest.fn().mockImplementation(() => ({
        registerMetric: jest.fn(),
        resetMetrics: jest.fn(),
        metrics: jest.fn().mockResolvedValue(''),
        setDefaultLabels: jest.fn(),
      })),
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
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      resetMetrics: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
      setDefaultLabels: jest.fn(),
    })),
    Counter: jest.fn().mockImplementation(() => {
      counterCallCount++
      if (counterCallCount === 1) return { inc: mockSuccessInc }
      return { inc: mockFailureInc }
    }),
    Histogram: jest.fn().mockImplementation(() => ({ observe: mockObserve })),
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
} from '../../../src/utils/job-metrics'

describe('job-metrics', () => {
  beforeEach(() => {
    mockSuccessInc.mockClear()
    mockFailureInc.mockClear()
    mockObserve.mockClear()
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
    it('increments job_failure_total with the correct job_name label', () => {
      recordJobFailure('session_cleanup', 300)
      expect(mockFailureInc).toHaveBeenCalledWith({
        job_name: 'session_cleanup',
      })
    })

    it('observes job_duration_ms with the correct job_name label and duration', () => {
      recordJobFailure('retention_processed_events', 750)
      expect(mockObserve).toHaveBeenCalledWith(
        { job_name: 'retention_processed_events' },
        750
      )
    })

    it('does not call inc on the success counter', () => {
      mockSuccessInc.mockClear()
      mockFailureInc.mockClear()
      recordJobFailure('retention_dead_letter_events', 200)
      expect(mockFailureInc).toHaveBeenCalledWith({
        job_name: 'retention_dead_letter_events',
      })
      expect(mockSuccessInc).not.toHaveBeenCalled()
    })
  })
})
