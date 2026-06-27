-- Rollback for 20260529000002_add_auth_nonces
-- Drops the auth nonce table (indexes drop with it).
-- Safe: nonces are short-lived challenge values, not durable state.

DROP TABLE IF EXISTS "auth_nonces";
