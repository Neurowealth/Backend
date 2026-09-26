process.env.NODE_ENV = 'test'
process.env.MESSAGING_DLQ_ALERT_THRESHOLD = '2'

import { runMessageDeliverySweep } from '../../../src/jobs/messageDeliverySweep'
import { messageDeliveryService } from '../../../src/messaging/service'
import { alertingService } from '../../../src/services/alerting'
import * as jobMetrics from '../../../src/utils/job-metrics'

jest.mock('../../../src/services/alerting', () => ({
  alertingService: {
    emit: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('../../../src/utils/job-metrics', () => ({
  recordJobSuccess: jest.fn(),
  recordJobFailure: jest.fn(),
}))

describe('Message Delivery Sweep Job (#493)', () => {
  beforeEach(() => {
    messageDeliveryService.clearStoreForTests()
    jest.restoreAllMocks()
  })

  it('successfully processes queue and records success metrics', async () => {
    const processSpy = jest
      .spyOn(messageDeliveryService, 'processPendingQueue')
      .mockResolvedValue({
        processed: 3,
        delivered: 2,
        retried: 1,
        deadLettered: 0,
      })

    const statsSpy = jest
      .spyOn(messageDeliveryService, 'getMessageStats')
      .mockResolvedValue({
        total: 3,
        byStatus: { pending: 1, sending: 0, delivered: 2, failed: 0, deadLetter: 0 },
        byChannel: {
          telegram: { total: 2, delivered: 2, failed: 0, pending: 0, deadLetter: 0 },
          whatsapp: { total: 1, delivered: 0, failed: 0, pending: 1, deadLetter: 0 },
        },
      })

    await runMessageDeliverySweep()

    expect(processSpy).toHaveBeenCalledWith(50)
    expect(statsSpy).toHaveBeenCalled()
    expect(jobMetrics.recordJobSuccess).toHaveBeenCalledWith(
      'message_delivery_sweep',
      expect.any(Number)
    )
  })

  it('emits an operational alert when dead letters exceed threshold', async () => {
    jest.spyOn(messageDeliveryService, 'processPendingQueue').mockResolvedValue({
      processed: 5,
      delivered: 2,
      retried: 0,
      deadLettered: 3,
    })

    jest.spyOn(messageDeliveryService, 'getMessageStats').mockResolvedValue({
      total: 5,
      byStatus: { pending: 0, sending: 0, delivered: 2, failed: 0, deadLetter: 3 },
      byChannel: {
        telegram: { total: 3, delivered: 1, failed: 0, pending: 0, deadLetter: 2 },
        whatsapp: { total: 2, delivered: 1, failed: 0, pending: 0, deadLetter: 1 },
      },
    })

    const emitSpy = jest.spyOn(alertingService, 'emit')

    await runMessageDeliverySweep()

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('DLQ Threshold Exceeded'),
        severity: 'warning',
        component: 'messaging_dlq',
      }),
      'messaging_dlq_threshold'
    )
  })

  it('records failure metric when sweep throws', async () => {
    jest
      .spyOn(messageDeliveryService, 'processPendingQueue')
      .mockRejectedValue(new Error('Queue processor failure'))

    await runMessageDeliverySweep()

    expect(jobMetrics.recordJobFailure).toHaveBeenCalledWith(
      'message_delivery_sweep',
      expect.any(Number),
      expect.any(Error)
    )
  })
})
