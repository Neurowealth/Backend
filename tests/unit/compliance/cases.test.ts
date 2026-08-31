// #393 — checkAndOpenCase's reopen check must exclude every terminal
// CaseStatus, not just CLOSED_NO_ACTION. A user with a case closed in a
// different terminal state (e.g. SAR_FILED, CLEARED) must get a fresh case
// for a new high-score event, not have evidence silently attached to the
// closed one.
const mockFindFirst = jest.fn()
const mockCaseCreate = jest.fn()
const mockEventCreate = jest.fn()

jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client')
  return {
    ...actual,
    PrismaClient: jest.fn().mockImplementation(() => ({
      complianceCase: {
        findFirst: mockFindFirst,
        create: mockCaseCreate,
      },
      caseEvent: {
        create: mockEventCreate,
      },
    })),
  }
})

import { checkAndOpenCase } from '../../../src/compliance/cases'

const HIGH_SCORE = 80
const LOW_SCORE = 10

beforeEach(() => {
  jest.clearAllMocks()
})

describe('checkAndOpenCase', () => {
  it('does nothing below the case-open score threshold', async () => {
    await checkAndOpenCase('user-1', 'tx-1', LOW_SCORE)
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockCaseCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('opens a new case when the user has none', async () => {
    mockFindFirst.mockResolvedValue(null)
    mockCaseCreate.mockResolvedValue({ id: 'case-1' })

    await checkAndOpenCase('user-1', 'tx-1', HIGH_SCORE)

    expect(mockCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          openedReason: 'score_threshold',
          triggerScore: HIGH_SCORE,
          relatedTxnIds: ['tx-1'],
        }),
      })
    )
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('attaches evidence to an existing non-terminal (OPEN) case instead of opening a new one', async () => {
    mockFindFirst.mockResolvedValue({ id: 'case-1', status: 'OPEN' })

    await checkAndOpenCase('user-1', 'tx-2', HIGH_SCORE)

    expect(mockEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: 'case-1',
          type: 'EVIDENCE',
          body: { txId: 'tx-2', score: HIGH_SCORE },
        }),
      })
    )
    expect(mockCaseCreate).not.toHaveBeenCalled()
  })

  it('excludes CLOSED_NO_ACTION cases from the reopen lookup (the pre-existing behavior)', async () => {
    mockFindFirst.mockResolvedValue(null) // simulates the DB filter excluding it
    mockCaseCreate.mockResolvedValue({ id: 'case-2' })

    await checkAndOpenCase('user-1', 'tx-3', HIGH_SCORE)

    const whereArg = mockFindFirst.mock.calls[0][0].where
    expect(whereArg.status.notIn).toContain('CLOSED_NO_ACTION')
    expect(mockCaseCreate).toHaveBeenCalled()
  })

  // The bug (#393): the original filter was `status: { not: 'CLOSED_NO_ACTION' }`,
  // which treats every OTHER terminal status (SAR_FILED, CLEARED) as still
  // "open" and would incorrectly attach new evidence to them.
  it.each(['SAR_FILED', 'CLEARED'])(
    'opens a fresh case for a user whose only case is closed as %s, rather than attaching to it',
    async (terminalStatus) => {
      // The real Prisma `notIn` filter would exclude this row from the
      // findFirst result — assert the filter actually names every terminal
      // status, then simulate what a correct filter returns (null).
      mockFindFirst.mockResolvedValue(null)
      mockCaseCreate.mockResolvedValue({ id: 'case-new' })

      await checkAndOpenCase('user-1', 'tx-4', HIGH_SCORE)

      const whereArg = mockFindFirst.mock.calls[0][0].where
      expect(whereArg.status.notIn).toContain(terminalStatus)

      // A new case is opened, not evidence attached to the closed one.
      expect(mockCaseCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1' }),
        })
      )
      expect(mockEventCreate).not.toHaveBeenCalled()
    }
  )

  it('the reopen filter excludes every terminal status defined in the schema', async () => {
    mockFindFirst.mockResolvedValue(null)
    mockCaseCreate.mockResolvedValue({ id: 'case-1' })

    await checkAndOpenCase('user-1', 'tx-1', HIGH_SCORE)

    const whereArg = mockFindFirst.mock.calls[0][0].where
    expect(whereArg.status.notIn.sort()).toEqual(
      ['CLEARED', 'CLOSED_NO_ACTION', 'SAR_FILED'].sort()
    )
  })

  it('still attaches evidence to a case in a non-terminal, non-OPEN status (e.g. INVESTIGATING)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'case-3', status: 'INVESTIGATING' })

    await checkAndOpenCase('user-1', 'tx-5', HIGH_SCORE)

    expect(mockEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ caseId: 'case-3' }),
      })
    )
    expect(mockCaseCreate).not.toHaveBeenCalled()
  })
})
