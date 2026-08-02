-- Rollback for 20260721000000_add_savings_goals
-- Drops the savings goals table and the GoalStatus enum.
-- WARNING: Destroys all user savings goals and their progress state.
--
-- NOTE: The 'GOAL_PROGRESS' value added to the "AgentAction" enum is NOT
-- removed. PostgreSQL cannot drop a single enum value, and any AgentLog rows
-- already written with that action would be orphaned. The value is left in
-- place; it is inert once the savings goals table is gone.

ALTER TABLE "savings_goals" DROP CONSTRAINT IF EXISTS "savings_goals_positionId_fkey";

ALTER TABLE "savings_goals" DROP CONSTRAINT IF EXISTS "savings_goals_userId_fkey";

DROP TABLE IF EXISTS "savings_goals";

DROP TYPE IF EXISTS "GoalStatus";
