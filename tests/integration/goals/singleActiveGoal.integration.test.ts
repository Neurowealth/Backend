/**
 * Integration tests for the single-ACTIVE-savings-goal invariant (#790),
 * against a real Postgres database.
 *
 * `createGoal` pre-checks for an existing ACTIVE goal with `findFirst`, which
 * is racy: two concurrent POSTs can both pass it. The durable guard is the
 * partial unique index `savings_goals_userId_active_key`
 * (migration 20261123000000_savings_goal_single_active), whose violation
 * Prisma surfaces as P2002 and which `createGoal` maps to GoalConflictError.
 *
 * Excluded from the default `npm test` run (see jest.config.js) because it
 * needs a live DB. Run it with:
 *
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     npm run test:integration:goals
 *
 * CI runs it in the `ci` job, where Postgres is provisioned and migrations
 * have been applied.
 */
import db from '../../../src/db'
import {
  createGoal,
  cancelGoal,
  GoalConflictError,
} from '../../../src/goals/service'

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

function uuid(): string {
  return `it-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function seedUser() {
  return db.user.create({
    data: {
      walletAddress: `G${uuid().replace(/-/g, '').slice(0, 47)}`.slice(0, 56),
      network: 'TESTNET',
      email: `${uuid()}@example.com`,
      isActive: true,
    },
  })
}

const targetDate = new Date(Date.now() + 90 * 86_400_000)

afterAll(async () => {
  await db.$disconnect()
})

describe('savings goal single-ACTIVE invariant (#790)', () => {
  it('the partial unique index exists', async () => {
    const rows = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'savings_goals'
        AND indexname = 'savings_goals_userId_active_key'
    `
    expect(rows).toHaveLength(1)
  })

  it('two concurrent creates produce exactly one ACTIVE goal', async () => {
    const user = await seedUser()

    const results = await Promise.allSettled([
      createGoal(user.id, { targetAmount: 1000, targetDate }),
      createGoal(user.id, { targetAmount: 2000, targetDate }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      GoalConflictError
    )

    const activeCount = await db.savingsGoal.count({
      where: { userId: user.id, status: 'ACTIVE' },
    })
    expect(activeCount).toBe(1)
  })

  it('rejects a second ACTIVE goal created after the first', async () => {
    const user = await seedUser()
    await createGoal(user.id, { targetAmount: 1000, targetDate })

    await expect(
      createGoal(user.id, { targetAmount: 2000, targetDate })
    ).rejects.toBeInstanceOf(GoalConflictError)
  })

  it('allows a new ACTIVE goal once the previous one is cancelled', async () => {
    const user = await seedUser()
    const first = await createGoal(user.id, { targetAmount: 1000, targetDate })
    await cancelGoal(first.id)

    const second = await createGoal(user.id, { targetAmount: 2000, targetDate })
    expect(second.status).toBe('ACTIVE')

    const activeCount = await db.savingsGoal.count({
      where: { userId: user.id, status: 'ACTIVE' },
    })
    expect(activeCount).toBe(1)
  })
})
