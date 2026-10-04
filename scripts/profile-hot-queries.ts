import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const minimumRowsForPlanAssertion = Number(
  process.env.PERF_MIN_ROWS_FOR_INDEX_ASSERTION || 10_000
)

interface IndexExpectation {
  table: string
  name: string
}

interface ExplainRow {
  'QUERY PLAN': unknown
}

const expectedIndexes: IndexExpectation[] = [
  {
    table: 'user_webhook_deliveries',
    name: 'user_webhook_deliveries_endpointId_createdAt_idx',
  },
  {
    table: 'webhook_deliveries',
    name: 'webhook_deliveries_subscriptionId_status_createdAt_idx',
  },
  {
    table: 'webhook_dead_letters',
    name: 'webhook_dead_letters_subscriptionId_status_firstFailedAt_idx',
  },
]

async function assertIndexExists({ table, name }: IndexExpectation) {
  const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = ${table}
  `
  if (!indexes.some((index) => index.indexname === name)) {
    throw new Error(`Missing hot-query index ${name} on ${table}`)
  }
}

async function estimatedTableRows(table: string): Promise<number> {
  const [result] = await prisma.$queryRaw<{ estimated_rows: bigint }[]>`
    SELECT GREATEST(reltuples, 0)::bigint AS estimated_rows
    FROM pg_class
    WHERE oid = to_regclass(${table})
  `
  return Number(result?.estimated_rows ?? 0)
}

function planUsesIndex(plan: unknown, expectedName: string): boolean {
  if (!plan || typeof plan !== 'object') return false
  const node = plan as Record<string, unknown>
  if (node['Index Name'] === expectedName) return true
  const children = node.Plans
  return Array.isArray(children)
    ? children.some((child) => planUsesIndex(child, expectedName))
    : false
}

async function profile(
  name: string,
  table: string,
  expectedIndex: string,
  query: string,
  ...params: unknown[]
): Promise<void> {
  const [rowCount, explain] = await Promise.all([
    estimatedTableRows(table),
    prisma.$queryRawUnsafe<ExplainRow[]>(query, ...params),
  ])
  const plan = explain[0]?.['QUERY PLAN']
  const root = Array.isArray(plan) ? plan[0]?.Plan : undefined

  console.log(JSON.stringify({ name, estimatedRows: rowCount, plan }, null, 2))

  if (
    rowCount >= minimumRowsForPlanAssertion &&
    !planUsesIndex(root, expectedIndex)
  ) {
    throw new Error(
      `${name} did not use ${expectedIndex} with ${rowCount} estimated rows`
    )
  }
}

async function main(): Promise<void> {
  for (const index of expectedIndexes) await assertIndexExists(index)

  const endpointId =
    process.env.PERF_PROFILE_ENDPOINT_ID ??
    '00000000-0000-0000-0000-000000000000'
  const subscriptionId =
    process.env.PERF_PROFILE_SUBSCRIPTION_ID ??
    '00000000-0000-0000-0000-000000000000'
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  await profile(
    'user_webhook_delivery_history',
    'user_webhook_deliveries',
    'user_webhook_deliveries_endpointId_createdAt_idx',
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT "id", "createdAt"
     FROM "user_webhook_deliveries"
     WHERE "endpointId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    endpointId,
    50
  )

  await profile(
    'webhook_health_recent_failures',
    'webhook_deliveries',
    'webhook_deliveries_subscriptionId_status_createdAt_idx',
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT count(*)
     FROM "webhook_deliveries"
     WHERE "subscriptionId" = $1
       AND "status" = 'FAILED'
       AND "createdAt" >= $2`,
    subscriptionId,
    since
  )

  await profile(
    'webhook_dead_letter_replay',
    'webhook_dead_letters',
    'webhook_dead_letters_subscriptionId_status_firstFailedAt_idx',
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT "id", "firstFailedAt"
     FROM "webhook_dead_letters"
     WHERE "subscriptionId" = $1
       AND "status" = 'PENDING'
       AND "firstFailedAt" >= $2
     ORDER BY "firstFailedAt" ASC
     LIMIT $3`,
    subscriptionId,
    since,
    50
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
