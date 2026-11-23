-- Enforce at most one ACTIVE savings goal per user (#790).
--
-- The application-level findFirst-then-create check is racy: two concurrent
-- POSTs can both pass it and insert two ACTIVE goals, after which getGoalForUser
-- picks one arbitrarily. This partial unique index makes the invariant durable
-- at the database layer. createGoal maps the resulting P2002 to GoalConflictError.
--
-- Prisma does not model partial indexes in schema.prisma, so this index is
-- migration-managed. Do not drop it in a future migration.
CREATE UNIQUE INDEX "savings_goals_userId_active_key"
  ON "savings_goals" ("userId")
  WHERE "status" = 'ACTIVE';
