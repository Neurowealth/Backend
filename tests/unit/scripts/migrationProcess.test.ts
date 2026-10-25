/**
 * Structural checks for the migration process (#470).
 *
 * The bash gate in CI (scripts/check-migration-rollback.sh) catches a missing
 * rollback.sql. This suite covers the parts bash cannot see: that every rollback
 * is actually idempotent, that the rehearsal harness exists and is wired to the
 * rollback script, and that the documented process still names backup, downtime
 * and rollback strategy. A doc that silently loses its downtime section should
 * fail the build, not a production deploy.
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations')

const migrationDirs = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const read = (...segments: string[]): string =>
  fs.readFileSync(path.join(...segments), 'utf8')

describe('migration rollback coverage', () => {
  it('has migrations to check', () => {
    expect(migrationDirs.length).toBeGreaterThan(0)
  })

  it.each(migrationDirs)('%s ships a non-empty rollback.sql', (name) => {
    const file = path.join(MIGRATIONS_DIR, name, 'rollback.sql')
    expect(fs.existsSync(file)).toBe(true)
    expect(read(file).trim().length).toBeGreaterThan(0)
  })

  it.each(migrationDirs)('%s rollback.sql is idempotent', (name) => {
    const sql = read(MIGRATIONS_DIR, name, 'rollback.sql')

    // Strip comments so a phrase in a comment cannot satisfy the assertion.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim()

    if (statements.length === 0) return

    // Every destructive statement must be guarded, otherwise re-running the
    // rollback after a partial failure aborts the transaction.
    const destructive = statements
      .split(';')
      .map((s) => s.trim())
      .filter(
        (s) =>
          /^DROP\s+(TABLE|COLUMN|INDEX|TYPE|SEQUENCE)\b/i.test(s) ||
          /^ALTER\s+TABLE\b.*\bDROP\b/i.test(s)
      )

    expect(destructive.length).toBeGreaterThan(0)
    for (const statement of destructive) {
      expect(statement).toMatch(/\bIF\s+EXISTS\b|\bIF\s+NOT\s+EXISTS\b/i)
    }
  })

  it.each(migrationDirs)('%s rollback.sql identifies its migration', (name) => {
    const sql = read(MIGRATIONS_DIR, name, 'rollback.sql')
    expect(sql).toContain(name)
  })
})

describe('rollback rehearsal harness', () => {
  const scriptPath = path.join(
    ROOT,
    'scripts',
    'rehearse-migration-rollback.sh'
  )

  it('exists and is executable', () => {
    expect(fs.existsSync(scriptPath)).toBe(true)
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0)
  })

  it('brings the database to head before rehearsing', () => {
    const script = read(scriptPath)
    expect(script).toContain('prisma migrate deploy')
  })

  it('applies both rollback.sql and migration.sql itself', () => {
    // The rehearsal runs the SQL directly instead of delegating to
    // rollback-migration.sh: touching Prisma's history is what makes a broken
    // rollback invisible, so the rehearsal must leave the history alone.
    const script = read(scriptPath)
    expect(script).toContain('rollback.sql')
    expect(script).toContain('migration.sql')
    expect(script).not.toContain('scripts/rollback-migration.sh')
  })

  it('proves the rollback is not a no-op and the round trip is exact', () => {
    const script = read(scriptPath)
    expect(script).toContain('schema_fingerprint')
    expect(script).toMatch(/did not change the schema/)
  })

  it('verifies migration history rather than assuming the SQL worked', () => {
    const script = read(scriptPath)
    expect(script).toContain('rolled_back_at')
    expect(script).toContain('finished_at')
  })

  it('refuses to rehearse against a production-looking database in CI', () => {
    const script = read(scriptPath)
    expect(script).toMatch(/prod|production/)
    expect(script).toContain('DATABASE_URL')
  })
})

describe('documented migration process', () => {
  const docPath = path.join(ROOT, 'docs', 'MIGRATIONS.md')
  const doc = fs.existsSync(docPath) ? read(docPath) : ''

  it('exists', () => {
    expect(fs.existsSync(docPath)).toBe(true)
  })

  it('contains the pre-flight checklist', () => {
    expect(doc).toContain('## 6. Applying a migration')
    expect(doc).toContain('### Pre-flight checklist')
    expect(doc).toMatch(/- \[ \] .*snapshot/i)
  })

  it('documents backup and downtime impact', () => {
    expect(doc).toContain('### Downtime impact')
    expect(doc).toMatch(/\*\*Backup\*\*/)
    expect(doc).toMatch(/lock_timeout|ACCESS EXCLUSIVE/)
  })

  it('documents the rollback tiers and the rehearsal', () => {
    expect(doc).toContain('### 6.1 Choosing a rollback tier')
    expect(doc).toContain('scripts/rollback-migration.sh')
    expect(doc).toContain('scripts/rehearse-migration-rollback.sh')
  })

  it('is referenced from the deployment guide and the doc index', () => {
    expect(read(ROOT, 'docs', 'DEPLOYMENT.md')).toContain('MIGRATIONS.md')
    expect(read(ROOT, 'docs', 'DOCUMENTATION_INDEX.md')).toContain(
      'MIGRATIONS.md'
    )
  })
})
