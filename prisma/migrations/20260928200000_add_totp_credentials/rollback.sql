-- Rollback of TOTP-based two-factor authentication
DROP TABLE IF EXISTS "totp_credentials";
