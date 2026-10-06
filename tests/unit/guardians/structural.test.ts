/**
 * Structural guards for the #535 recovery migration.
 *
 * `prisma/schema.prisma` cannot express CHECK constraints or partial indexes, so
 * both live only in migration.sql. That makes them invisible to `prisma validate`,
 * invisible to the generated client, and invisible to review of the schema alone
 * -- the exact properties that decide whether a locked-out owner gets their
 * account back safely.
 *
 * These tests read the SQL as text and assert the invariants are still present.
 * They are intentionally cheap and DB-free: they are the last line that fails
 * when someone regenerates the migration from the schema and silently drops the
 * parts Prisma does not model.
 */

import * as fs from 'fs'
import * as path from 'path'

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../../prisma/migrations/20260930140000_add_guardian_recovery'
)

const migrationSql = fs.readFileSync(
  path.join(MIGRATION_DIR, 'migration.sql'),
  'utf8'
)
const rollbackSql = fs.readFileSync(
  path.join(MIGRATION_DIR, 'rollback.sql'),
  'utf8'
)

/** Collapse runs of whitespace so assertions do not depend on formatting. */
const flatten = (sql: string) => sql.replace(/\s+/g, ' ')

describe('#535 migration structure', () => {
  describe('invariants Prisma cannot express', () => {
    it('forbids a quorum below 2', () => {
      // Quorum 1 means the claimant's own nomination of a single colluding
      // guardian recovers the account -- no independent second party.
      expect(flatten(migrationSql)).toContain(
        'ADD CONSTRAINT "recovery_policies_required_approvals_check" CHECK ("requiredApprovals" >= 2)'
      )
    })

    it('forbids a recovery delay below 24h', () => {
      // The delay is the window in which a real owner notices and cancels. Zero
      // collapses social recovery into an instant takeover primitive.
      expect(flatten(migrationSql)).toContain(
        'ADD CONSTRAINT "recovery_policies_delay_hours_check" CHECK ("recoveryDelayHours" >= 24)'
      )
    })

    it('allows at most one live recovery request per account', () => {
      // The service reads for an existing live request before creating one, but
      // read-then-write races on a public unauthenticated endpoint. This index is
      // the actual guarantee; the service check is only a friendly early error.
      expect(flatten(migrationSql)).toContain(
        'CREATE UNIQUE INDEX "recovery_requests_userId_live_key" ON "recovery_requests"("userId") WHERE "status" IN (\'PENDING\', \'QUORUM_REACHED\')'
      )
    })

    it('scopes the live-request index to live statuses only', () => {
      // A plain unique constraint on userId would permanently block a second
      // recovery attempt after the first closed -- unacceptable for a feature
      // that exists to rescue locked-out accounts.
      const index = flatten(migrationSql).match(
        /CREATE UNIQUE INDEX "recovery_requests_userId_live_key"[^;]*/
      )
      expect(index).not.toBeNull()
      expect(index![0]).toContain('WHERE')
      expect(index![0]).not.toMatch(/WHERE\s+"?status"?\s+IS NOT/i)
    })
  })

  describe('token storage', () => {
    it('stores invite tokens only as a hash', () => {
      // A raw token column would mean one DB read is a full account takeover for
      // any guardian, and the column name makes the mistake easy to reintroduce.
      expect(migrationSql).not.toMatch(/inviteToken\s+(TEXT|VARCHAR|CITEXT)/i)
      expect(flatten(migrationSql)).toContain(
        'CREATE UNIQUE INDEX "recovery_guardians_inviteTokenHash_key"'
      )
    })
  })

  describe('rollback', () => {
    it('drops the live-request partial unique index', () => {
      expect(rollbackSql).toContain(
        'DROP INDEX IF EXISTS "recovery_requests_userId_live_key"'
      )
    })

    it('drops every table the migration creates', () => {
      for (const table of [
        'recovery_approvals',
        'recovery_requests',
        'recovery_policies',
        'recovery_guardians',
      ]) {
        expect(rollbackSql).toContain(`DROP TABLE IF EXISTS "${table}"`)
      }
    })

    it('reverses the CHECK constraints by dropping their tables', () => {
      // CHECKs are not dropped explicitly: they belong to tables the rollback
      // drops outright. Guard that the tables really do go, so the constraint
      // cannot outlive them.
      expect(flatten(rollbackSql)).toContain(
        'DROP TABLE IF EXISTS "recovery_policies"'
      )
    })
  })

  describe('no execution endpoint', () => {
    it('has no owner-callable execute path in the migration', () => {
      // Execution is job-only. Nothing in the schema should imply the HTTP layer
      // can drive it.
      expect(migrationSql).not.toMatch(/executeToken/i)
      expect(migrationSql).not.toMatch(/approvedBy/i)
    })
  })
})
