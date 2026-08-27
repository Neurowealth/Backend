-- rollback.sql — reverse of 20260529000002_add_auth_nonces/migration.sql
-- Drops the auth_nonces table and all its indexes.

DROP TABLE IF EXISTS "auth_nonces" CASCADE;
