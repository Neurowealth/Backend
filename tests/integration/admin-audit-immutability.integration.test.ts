/**
 * Integration Test: AdminAuditLog Append-Only Immutability & Retention (#682)
 *
 * Verifies that AdminAuditLog is strictly append-only at the database layer:
 * 1. Attempted UPDATE operations via application/app-role fail unconditionally.
 * 2. Attempted DELETE operations fail by default with an append-only exception or privilege denial.
 * 3. Setting legal hold (`neuro.legal_hold = 'true'`) blocks purge-function calls.
 * 4. Authorized retention purges use the bounded database function.
 */

process.env.NODE_ENV = 'test'

import db from '../../src/db'

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip

describeWithDatabase(
  'AdminAuditLog DB-Level Append-Only Immutability (#682)',
  () => {
    let testLogId: string | null = null
    const expiredCutoff = () => new Date(Date.now() - 366 * 86400000)

    beforeAll(async () => {
      await db.$connect()
      const [trigger] = await db.$queryRawUnsafe<
        Array<{ installed: boolean }>
      >(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_admin_audit_logs_append_only'
          AND tgrelid = 'public.admin_audit_logs'::regclass
          AND NOT tgisinternal
      ) AS installed
    `)
      expect(trigger?.installed).toBe(true)
    })

    afterAll(async () => {
      if (testLogId) {
        await db.$queryRawUnsafe(
          'SELECT public.purge_admin_audit_logs(ARRAY[$1]::text[], $2::timestamptz)',
          testLogId,
          expiredCutoff()
        )
      }
      await db.$disconnect()
    })

    beforeEach(async () => {
      // Create an audit entry for each test
      const log = await db.adminAuditLog.create({
        data: {
          action: 'INTEGRATION_TEST_ACTION',
          result: 'success',
          target: '/test',
          ipAddress: '127.0.0.1',
          createdAt: new Date(Date.now() - 400 * 86400000),
        },
      })
      testLogId = log.id
    })

    afterEach(async () => {
      if (!testLogId) return
      await db.$queryRawUnsafe(
        'SELECT public.purge_admin_audit_logs(ARRAY[$1]::text[], $2::timestamptz)',
        testLogId,
        expiredCutoff()
      )
      testLogId = null
    })

    it('allows INSERT operations into admin_audit_logs', async () => {
      expect(testLogId).toBeDefined()
      const record = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(record).not.toBeNull()
      expect(record?.action).toBe('INTEGRATION_TEST_ACTION')
    })

    it('fails attempted UPDATE operations via app role at the DB layer', async () => {
      await expect(
        db.adminAuditLog.update({
          where: { id: testLogId! },
          data: {
            result: 'modified_result',
          },
        })
      ).rejects.toThrow(
        /append-only: UPDATE operations are strictly prohibited|permission denied/i
      )

      // Verify record remains untouched
      const untouched = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(untouched?.result).toBe('success')
    })

    it('fails attempted DELETE operations via app role at the DB layer', async () => {
      await expect(
        db.adminAuditLog.delete({
          where: { id: testLogId! },
        })
      ).rejects.toThrow(
        /append-only: DELETE operations are strictly prohibited|permission denied/i
      )

      // Verify record was not deleted
      const record = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(record).not.toBeNull()
    })

    it('fails attempted deleteMany operations via app role at the DB layer', async () => {
      await expect(
        db.adminAuditLog.deleteMany({ where: { id: testLogId! } })
      ).rejects.toThrow(
        /append-only: DELETE operations are strictly prohibited|permission denied/i
      )

      const record = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(record).not.toBeNull()
    })

    it('blocks retention purge when legal hold is active', async () => {
      await expect(
        db.$transaction(async (tx) => {
          // Even if allow purge is requested, legal hold takes strict precedence
          await tx.$executeRawUnsafe("SET LOCAL neuro.legal_hold = 'true'")
          await tx.$queryRawUnsafe(
            'SELECT public.purge_admin_audit_logs(ARRAY[$1]::text[], $2::timestamptz)',
            testLogId,
            expiredCutoff()
          )
        })
      ).rejects.toThrow(
        /protected by legal hold: DELETE operations are prohibited/i
      )

      // Verify record was not deleted
      const record = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(record).not.toBeNull()
    })

    it('allows bounded retention purge through the privileged database function', async () => {
      await expect(
        db.$queryRawUnsafe(
          'SELECT public.purge_admin_audit_logs(ARRAY[$1]::text[], $2::timestamptz)',
          testLogId,
          new Date(Date.now() + 86400000)
        )
      ).rejects.toThrow(/newer than configured retention/i)

      await db.$transaction(async (tx) => {
        const deleted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT public.purge_admin_audit_logs(ARRAY[$1]::text[], $2::timestamptz) AS id',
          testLogId,
          expiredCutoff()
        )
        expect(deleted).toHaveLength(1)
      })

      const record = await db.adminAuditLog.findUnique({
        where: { id: testLogId! },
      })
      expect(record).toBeNull()
    })
  }
)
