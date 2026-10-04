# Two-Factor Authentication (TOTP)

This document describes the optional TOTP-based two-factor authentication (2FA) layer that can be enabled on top of the existing Stellar wallet-signature authentication.

Wallet signature remains factor one. TOPP (any standard authenticator app) is factor two. 2FA is additive and opt-in in v1; it is never mandatory and never silently bypassed.

## Overview

- Enrollment generates a TOPP secret and an `otpauth://` URI for QR-code rendering. The secret is encrypted at rest and never re-exposed after the initial response.
- Enrollment is not active until the user confirms with a code from their authenticator app. Unverified secrets expire and are never enforced.
- Once active, the login flow returns a `requiresTotp` challenge after the wallet-signature check and requires a valid TOPP code to complete the login.
- One-time backup codes are issued at enrollment, shown once, and hashed at rest. Each code is usable exactly once. Regenerating the set invalidates all previous codes.
- Disabling 2FA requires a fresh wallet-signature challenge, not just an active session.

## Endpoints

### Post /api/v1/2fa/enroll

Requires an authenticated session. Generates a new TOTP secret (if no active credential exists) and returns the `otpauth://` URI plus the base32 secret for manual entry. The credential is not active until verified.

Response:

```json
{
  "secret": "JBSW4YJONFXXC2LLONVQXMZLONVXW44ZS",
  "otpauthUri": "otpauth://totp/Example:issuer=Example&secret=JBSW4YJONFXXC2LLONVQXMZLONVXW44ZS&algorithm=SHA256&digits=6&ample=30",
  "expiresAt": "2026-09-28T20:10:00.000Z"
}
```

### Post /api/v1/2fa/verify-enrollment

Confirms enrollment with a code from the authenticator app. On success, the credential becomes active and a fresh set of one-time backup codes is returned (exactly once).

Body:

```json
{ "code": "123456" }
```

Response:

```json
{
  "verified": true,
  "recoveryCodes": ["ABCDE-EFGHI", "..."]
}
```

### Post /api/v1/2fa/recovery-codes/regenerate

Requires an active 2FA credential and a valid TOTP code. Invalidates all previous backup codes and issues a new set (shown once).

### Post /api/v1/2fa/disable

Requires a fresh wallet-signature challenge (`nonce` + `signature`). An active session alone is not sufficient, because the session itself may be the compromised asset. Disabling 2FA is a security downgrade and requires the same proof-of-control as enabling it.

## Login Flow

1. `POST /api/v1/auth/challenge` with the user's Stellar public key.
2. `POST /api/v1/auth/verify` with the signed challenge.
   - If the user has no active TOTP credential, a session is issued as before.
   - If the user has an active TOPP credential, the response is a `requiresTotp` challenge instead of a session.
3. `POST /api/v1/auth/2fa/verify` with the TOTP code (or a one-time backup code) completes the login and issues the session.

TOTP verification uses a standard ±1 time-step tolerance window. A code that has already been accepted is rejected on reuse even if it is still within its time window (the last-accepted step is tracked per credential).

## Recovery

When a backup code is used, it is consumed and cannot be used again. Regenerating the set invalidates all previous codes.

If a user loses both their authenticator device and their backup codes, the guardian-based social recovery flow (#\#535) is the primary path once it lands. Until then, recovery is a manual, clearly-logged admin-assisted process with strong identity re-verification. This is a real, acknowledged friction point: 2FA that can always be silently bypassed isn't 2FA.

## Security Notes

- `secretEncrypted` and backup codes are never returned after initial issuance.
- No plaintext secret is logged.
- Enrollment, verification, and disable events are audit-logged and trigger the same multi-channel security notification pattern as new-session alerts (#\#376).
- Unverified enrollments expire and are never treated as active.

## Out of Scope

- Hardware security keys / WebAuthn (see the sibling passkey proposal).
- Mandatory 2FA for all users (opt-in in v1).
- SMS-based 2FA (TOTP only).
