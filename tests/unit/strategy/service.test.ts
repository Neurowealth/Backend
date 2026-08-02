// Strategy marketplace service unit tests (#285). These pin the invariants that
// matter when one user's configuration starts driving another user's agent:
//   * configVersion bumps ONLY on a material change, and when it does, every
//     active follower's snapshot is rewritten in the SAME transaction
//   * a label-only edit notifies nobody
//   * unpublishing is immediate and does NOT sever follows
//   * self-follow is refused
//   * re-following swaps atomically (old follow closed, new one created)
//   * an orphaned follow (publisher deleted) still resolves and can be released
//   * no response path ever carries the publisher's userId
import db from '../../../src/db'
import { dispatchWebhookEvent } from '../../../src/services/webhookDispatcher'
import { sendWhatsAppMessage } from '../../../src/utils/twilio-client'
import {
  StrategyFollowNotFoundError,
  StrategyNotFoundError,
  StrategySelfFollowError,
  StrategyValidationError,
  followStrategy,
  getActiveFollow,
  getMarketplace,
  loadActiveFollowsForUsers,
  publishStrategy,
  unfollowStrategy,
  unpublishStrategy,
} from '../../../src/strategy/service'

jest.mock('../../../src/db', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../../src/services/webhookDispatcher', () => ({
  dispatchWebhookEvent: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/utils/twilio-client', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue('SM123'),
}))

const mockDb = db as any
const mockDispatch = dispatchWebhookEvent as jest.Mock
const mockWhatsApp = sendWhatsAppMessage as jest.Mock

const PUBLISHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOLLOWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STRATEGY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/** Lets the tested code run its callback against the same mock client. */
function transactionalDb() {
  return jest.fn(async (fn: any) => fn(mockDb))
}

/** Drains the fire-and-forget notification fan-out. */
async function flushNotifications(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mockDb.$transaction = transactionalDb()
  mockDb.user = { findUnique: jest.fn() }
  mockDb.publishedStrategy = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  }
  mockDb.strategyFollow = {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn(),
    update: jest.fn(),
  }
  mockDb.publishedStrategyMetric = {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  }
  mockDispatch.mockResolvedValue(undefined)
  mockWhatsApp.mockResolvedValue('SM123')
})

describe('publishStrategy', () => {
  const config = { strategyName: 'MAX_YIELD' as const, riskCeiling: 70 }

  it('creates a first listing at version 1 without notifying anyone', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue(null)
    mockDb.publishedStrategy.upsert.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield',
      strategyConfig: config,
      configVersion: 1,
      isPublished: true,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await publishStrategy(PUBLISHER, {
      label: 'Steady yield',
      strategyConfig: config,
    })

    expect(result.materialChange).toBe(false)
    expect(mockDb.publishedStrategy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: PUBLISHER } })
    )
    await flushNotifications()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('does NOT bump the version or notify for a label-only edit', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: STRATEGY_ID,
      strategyConfig: config,
      configVersion: 3,
    })
    mockDb.publishedStrategy.upsert.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield v2',
      strategyConfig: config,
      configVersion: 3,
      isPublished: true,
      publishedAt: new Date(),
    })

    const result = await publishStrategy(PUBLISHER, {
      label: 'Steady yield v2',
      strategyConfig: config,
    })

    expect(result.materialChange).toBe(false)
    expect(mockDb.publishedStrategy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ configVersion: 3 }),
      })
    )
    // The follower snapshot rewrite must NOT run for a cosmetic edit.
    expect(mockDb.strategyFollow.updateMany).not.toHaveBeenCalled()
    await flushNotifications()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('bumps the version and rewrites follower snapshots on a material change', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: STRATEGY_ID,
      strategyConfig: config,
      configVersion: 3,
    })
    const next = { strategyName: 'MAX_YIELD' as const, riskCeiling: 85 }
    mockDb.publishedStrategy.upsert.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield',
      strategyConfig: next,
      configVersion: 4,
      isPublished: true,
      publishedAt: new Date(),
    })
    mockDb.strategyFollow.findMany.mockResolvedValue([
      { followerUserId: FOLLOWER, follower: { phone: '+15550001111' } },
    ])

    const result = await publishStrategy(PUBLISHER, {
      label: 'Steady yield',
      strategyConfig: next,
    })

    expect(result.materialChange).toBe(true)
    expect(mockDb.strategyFollow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publishedStrategyId: STRATEGY_ID, unfollowedAt: null },
        data: expect.objectContaining({ appliedConfigVersion: 4 }),
      })
    )

    await flushNotifications()
    expect(mockDispatch).toHaveBeenCalledWith(
      'strategy.updated',
      expect.objectContaining({ followerUserId: FOLLOWER, configVersion: 4 })
    )
    expect(mockWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+15550001111' })
    )
  })

  it('never leaks the publisher userId into a notification payload', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: STRATEGY_ID,
      strategyConfig: config,
      configVersion: 1,
    })
    mockDb.publishedStrategy.upsert.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield',
      strategyConfig: { strategyName: 'MAX_YIELD' },
      configVersion: 2,
      isPublished: true,
      publishedAt: new Date(),
    })
    mockDb.strategyFollow.findMany.mockResolvedValue([
      { followerUserId: FOLLOWER, follower: { phone: null } },
    ])

    await publishStrategy(PUBLISHER, {
      label: 'Steady yield',
      strategyConfig: { strategyName: 'MAX_YIELD' },
    })
    await flushNotifications()

    const payload = JSON.stringify(mockDispatch.mock.calls[0][1])
    expect(payload).not.toContain(PUBLISHER)
    // A follower with no phone is skipped, not thrown.
    expect(mockWhatsApp).not.toHaveBeenCalled()
  })

  it('snapshots the caller‘s own User config when the body omits one', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      rebalanceStrategy: 'TARGET_ALLOCATION',
      strategyConfig: { targetAllocations: { Blend: 100 }, riskCeiling: 60 },
    })
    mockDb.publishedStrategy.findUnique.mockResolvedValue(null)
    mockDb.publishedStrategy.upsert.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Mine',
      strategyConfig: {},
      configVersion: 1,
      isPublished: true,
      publishedAt: new Date(),
    })

    await publishStrategy(PUBLISHER, { label: 'Mine' })

    expect(mockDb.publishedStrategy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          strategyConfig: {
            strategyName: 'TARGET_ALLOCATION',
            targetAllocations: { Blend: 100 },
            riskCeiling: 60,
          },
        }),
      })
    )
  })

  it('rejects a body-less publish when the caller has no strategy configured', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      rebalanceStrategy: null,
      strategyConfig: null,
    })

    await expect(publishStrategy(PUBLISHER, { label: 'Mine' })).rejects.toThrow(
      StrategyValidationError
    )
  })
})

describe('unpublishStrategy', () => {
  it('delists immediately and leaves follows intact', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: STRATEGY_ID,
      isPublished: true,
    })
    mockDb.publishedStrategy.update.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield',
      strategyConfig: {},
      configVersion: 1,
      isPublished: false,
      publishedAt: new Date(),
    })
    mockDb.strategyFollow.findMany.mockResolvedValue([
      { followerUserId: FOLLOWER, follower: { phone: '+15550001111' } },
    ])

    const result = await unpublishStrategy(PUBLISHER)

    expect(result.isPublished).toBe(false)
    expect(mockDb.publishedStrategy.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isPublished: false } })
    )
    // Follows are never closed by an unpublish.
    expect(mockDb.strategyFollow.updateMany).not.toHaveBeenCalled()

    await flushNotifications()
    expect(mockDispatch).toHaveBeenCalledWith(
      'strategy.unpublished',
      expect.objectContaining({ followerUserId: FOLLOWER })
    )
  })

  it('does not re-notify when the strategy was already unpublished', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue({
      id: STRATEGY_ID,
      isPublished: false,
    })
    mockDb.publishedStrategy.update.mockResolvedValue({
      id: STRATEGY_ID,
      label: 'Steady yield',
      strategyConfig: {},
      configVersion: 1,
      isPublished: false,
      publishedAt: new Date(),
    })

    await unpublishStrategy(PUBLISHER)
    await flushNotifications()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('404s when the caller has never published', async () => {
    mockDb.publishedStrategy.findUnique.mockResolvedValue(null)
    await expect(unpublishStrategy(PUBLISHER)).rejects.toThrow(
      StrategyNotFoundError
    )
  })
})

describe('followStrategy', () => {
  const published = {
    id: STRATEGY_ID,
    userId: PUBLISHER,
    label: 'Steady yield',
    strategyConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
    configVersion: 4,
  }

  it('refuses a self-follow', async () => {
    mockDb.publishedStrategy.findFirst.mockResolvedValue(published)
    await expect(followStrategy(PUBLISHER, STRATEGY_ID)).rejects.toThrow(
      StrategySelfFollowError
    )
    expect(mockDb.strategyFollow.create).not.toHaveBeenCalled()
  })

  it('404s for an unknown or unpublished strategy', async () => {
    mockDb.publishedStrategy.findFirst.mockResolvedValue(null)
    await expect(followStrategy(FOLLOWER, STRATEGY_ID)).rejects.toThrow(
      StrategyNotFoundError
    )
    // The query itself is what enforces "published only".
    expect(mockDb.publishedStrategy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STRATEGY_ID, isPublished: true },
      })
    )
  })

  it('swaps an existing follow atomically and snapshots the config', async () => {
    mockDb.publishedStrategy.findFirst.mockResolvedValue(published)
    mockDb.strategyFollow.create.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: STRATEGY_ID,
      appliedConfig: published.strategyConfig,
      appliedConfigVersion: 4,
      appliedAt: new Date(),
      followedAt: new Date(),
      publishedStrategy: { id: STRATEGY_ID, label: 'Steady yield' },
    })

    const follow = await followStrategy(FOLLOWER, STRATEGY_ID)

    // Both writes go through the same transaction callback, so the partial
    // unique index can never see two active rows for this user.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(mockDb.strategyFollow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followerUserId: FOLLOWER, unfollowedAt: null },
      })
    )
    expect(mockDb.strategyFollow.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appliedConfig: published.strategyConfig,
          appliedConfigVersion: 4,
        }),
      })
    )
    expect(JSON.stringify(follow)).not.toContain(PUBLISHER)
  })
})

describe('unfollowStrategy', () => {
  it('releases the caller‘s active follow', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: STRATEGY_ID,
    })
    mockDb.strategyFollow.update.mockResolvedValue({})

    const result = await unfollowStrategy(FOLLOWER, STRATEGY_ID)

    expect(result.id).toBe('follow-1')
    expect(mockDb.strategyFollow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'follow-1' } })
    )
  })

  it('releases an ORPHANED follow whose publisher deleted their account', async () => {
    // onDelete: SetNull leaves publishedStrategyId null; without this fallback
    // the follower would have no id left to name and could never unfollow.
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: null,
    })
    mockDb.strategyFollow.update.mockResolvedValue({})

    await expect(
      unfollowStrategy(FOLLOWER, STRATEGY_ID)
    ).resolves.toMatchObject({ id: 'follow-1' })
  })

  it('404s when the caller follows nothing', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue(null)
    await expect(unfollowStrategy(FOLLOWER, STRATEGY_ID)).rejects.toThrow(
      StrategyFollowNotFoundError
    )
  })

  it('404s when the id names a strategy the caller does not follow', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })
    await expect(unfollowStrategy(FOLLOWER, STRATEGY_ID)).rejects.toThrow(
      StrategyFollowNotFoundError
    )
    expect(mockDb.strategyFollow.update).not.toHaveBeenCalled()
  })
})

describe('getMarketplace', () => {
  it('queries only eligible metrics of published strategies, sorted in SQL', async () => {
    await getMarketplace({
      sortBy: 'sharpe',
      window: '90d',
      page: 2,
      limit: 20,
    })

    expect(mockDb.publishedStrategyMetric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          windowDays: 90,
          isEligible: true,
          publishedStrategy: { isPublished: true },
        },
        orderBy: [{ sharpe: 'desc' }, { computedAt: 'desc' }],
        skip: 20,
        take: 20,
      })
    )
  })

  it('never selects userId on the joined strategy', async () => {
    await getMarketplace({ sortBy: 'apy', window: '30d', page: 1, limit: 10 })

    const select =
      mockDb.publishedStrategyMetric.findMany.mock.calls[0][0].select
        .publishedStrategy.select
    expect(select).not.toHaveProperty('userId')
    expect(select).not.toHaveProperty('user')
  })
})

describe('getActiveFollow / loadActiveFollowsForUsers', () => {
  it('returns the follow snapshot without the publisher userId', async () => {
    mockDb.strategyFollow.findFirst.mockResolvedValue({
      id: 'follow-1',
      publishedStrategyId: STRATEGY_ID,
      appliedConfig: { strategyName: 'MAX_YIELD' },
    })

    await getActiveFollow(FOLLOWER)

    const select = mockDb.strategyFollow.findFirst.mock.calls[0][0].select
    expect(select).not.toHaveProperty('followerUserId')
    expect(select.publishedStrategy.select).not.toHaveProperty('userId')
  })

  it('short-circuits without a query for an empty user list', async () => {
    const result = await loadActiveFollowsForUsers([])
    expect(result.size).toBe(0)
    expect(mockDb.strategyFollow.findMany).not.toHaveBeenCalled()
  })

  it('keys follows by follower and sanitizes the stored snapshot', async () => {
    mockDb.strategyFollow.findMany.mockResolvedValue([
      {
        id: 'follow-1',
        followerUserId: FOLLOWER,
        publishedStrategyId: STRATEGY_ID,
        // Written by an older version: an unknown strategy and a stray key.
        appliedConfig: { strategyName: 'MOON_MODE', riskTolerance: 9 },
        appliedConfigVersion: 2,
      },
    ])

    const result = await loadActiveFollowsForUsers([FOLLOWER])

    expect(result.get(FOLLOWER)).toEqual({
      followId: 'follow-1',
      followedStrategyId: STRATEGY_ID,
      appliedConfig: {},
      appliedConfigVersion: 2,
    })
  })

  it('resolves an orphaned follow with its config intact', async () => {
    mockDb.strategyFollow.findMany.mockResolvedValue([
      {
        id: 'follow-1',
        followerUserId: FOLLOWER,
        publishedStrategyId: null,
        appliedConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
        appliedConfigVersion: 4,
      },
    ])

    const result = await loadActiveFollowsForUsers([FOLLOWER])

    expect(result.get(FOLLOWER)).toMatchObject({
      followedStrategyId: null,
      appliedConfig: { strategyName: 'MAX_YIELD', riskCeiling: 70 },
    })
  })
})
