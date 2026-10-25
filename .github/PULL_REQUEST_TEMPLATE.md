## Description

<!-- Briefly describe what this PR does -->

## Related Issues

<!-- Link related issues using: Closes #ISSUE_NUMBER -->

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Checklist

- [ ] My code follows the existing code style of this project
- [ ] I have run `npm run lint` with no errors
- [ ] I have run `npm run typecheck` with no errors
- [ ] I have added tests that prove my fix/feature works
- [ ] All new and existing tests pass (`npm test`)
- [ ] I have updated documentation accordingly

## Database Migration (only if `prisma/migrations/**` changed)

<!-- See docs/MIGRATIONS.md for the full process. Delete this section otherwise. -->

**Class** (A metadata / B blocking DDL / C backfill / D irreversible):

**Backup taken** (snapshot identifier, or `n/a` for class A):

**Downtime impact**

- Locks taken: <!-- ACCESS EXCLUSIVE / ROW EXCLUSIVE / none -->
- Expected lock duration:
- Writes blocked during migration: <!-- yes / no -->
- Requires traffic drain: <!-- yes / no -->
- Rollback tier: <!-- 1 app-only / 2 rollback.sql / 3 snapshot restore -->

- [ ] `rollback.sql` ships in the same commit and is idempotent
- [ ] Rollback rehearsed with `bash scripts/rehearse-migration-rollback.sh`
- [ ] Added columns are nullable or defaulted (previous app version keeps working)
- [ ] Indexes on request-path tables use `CREATE INDEX CONCURRENTLY`
- [ ] Previous application version still works against the new schema

## Screenshots (if applicable)

<!-- Add screenshots to help explain your changes -->
