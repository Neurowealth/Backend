-- rollback.sql — reverse of 20261008092000_webauthn/migration.sql
-- Remove WebAuthn credentials and outstanding challenges.
-- WARNING: DATA LOSS — registered WebAuthn credentials and pending challenges
-- are permanently removed. Users will need to register credentials again.
-- Safe to run multiple times.

DROP TABLE IF EXISTS "webauthn_challenges";
DROP TABLE IF EXISTS "webauthn_credentials";
