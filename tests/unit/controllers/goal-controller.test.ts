// #841 — the single-ACTIVE-goal race must surface as a deterministic 409 at
// the HTTP boundary. The service already maps the partial unique index to
// GoalConflictError; this pins the controller's response contract.
process.env.NODE_ENV = 'test'

import type { Request, Response } from 'express'
import { createGoalHandler } from '../../../src/controllers/goal-controller'
import { createGoal, GoalConflictError } from '../../../src/goals/service'

jest.mock('../../../src/goals/service', () => ({
  createGoal: jest.fn(),
  GoalConflictError: class GoalConflictError extends Error {},
  GoalNotFoundError: class GoalNotFoundError extends Error {},
  GoalValidationError: class GoalValidationError extends Error {},
}))

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockCreateGoal = createGoal as jest.Mock

function makeRes(): Response & { json: jest.Mock; status: jest.Mock } {
  const res = {} as Response & { json: jest.Mock; status: jest.Mock }
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function makeReq(body: unknown = {}) {
  return { userId: 'user-1', body } as unknown as Request
}

describe('createGoalHandler conflict response (#841)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('maps GoalConflictError to 409 with a safe CONFLICT envelope', async () => {
    mockCreateGoal.mockRejectedValue(
      new GoalConflictError(
        'An active savings goal already exists for this user'
      )
    )
    const res = makeRes()

    await createGoalHandler(makeReq(), res)

    expect(mockCreateGoal).toHaveBeenCalledWith('user-1', {})
    expect(res.status).toHaveBeenCalledWith(409)
    const body = res.json.mock.calls[0][0]
    expect(body).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'An active savings goal already exists for this user',
    })
    expect(JSON.stringify(body)).not.toContain('GoalConflictError')
    expect(JSON.stringify(body)).not.toContain('    at ')
  })

  it('does not log an expected conflict as a server error', async () => {
    mockCreateGoal.mockRejectedValue(new GoalConflictError('conflict'))
    const res = makeRes()
    const { logger } = require('../../../src/utils/logger')

    await createGoalHandler(makeReq(), res)

    expect(logger.error).not.toHaveBeenCalled()
  })
})
