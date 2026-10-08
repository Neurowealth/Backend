# Optional passkeys

Wallet-signature login remains the account identity and recovery mechanism.
Only an active session can enroll, list or remove passkeys. API keys cannot
enroll credentials. Enrollment never creates a user or replaces a wallet.

Set `WEBAUTHN_RP_ID` to the relying-party domain and `WEBAUTHN_ORIGIN` to the
exact HTTPS frontend origin, without a trailing slash. Optionally set
`WEBAUTHN_RP_NAME`. Production/staging require explicit configuration. Development
defaults to `localhost` and `http://localhost:3000`. Request Host headers never
determine trusted RP or origin values.

1. Call `POST /api/v1/auth/webauthn/register-options` with an active session.
2. Pass `options` to a WebAuthn browser client, then POST its serialized result
   as `response` with `challengeId` and optional `deviceLabel` to `register-verify`.
3. For login, request `login-options` with optional `userId`. Omitting userId
   supports discoverable passkeys. Send the assertion and challengeId to
   `login-verify`.
4. List metadata at `GET /api/v1/webauthn/credentials` and delete an owned
   credential at `DELETE /api/v1/webauthn/credentials/:id`.

Challenges expire after five minutes, live in the database for multi-instance
deployments, and are consumed atomically before verification. Registration
challenges are tied to the issuing user and session. Malformed requests and
replayed, expired, cross-session or wrong-account challenges are rejected.

SimpleWebAuthn verifies challenges, signatures, origins and RP IDs. User
verification is required. Attestation uses `none` for platform and synced
passkeys without identifying-device certificates; unsupported or invalid
attestations are rejected by the library. This policy does not claim a hardware
vendor allowlist or enterprise device trust.

Positive signature counters must strictly increase. Stalls/regressions reject
login and trigger security alerts, including anomalies thrown by the library.
Authenticators that consistently report zero are supported, as required for
common synced passkeys; their replay defense is the single-use challenge.
Counter updates compare against the previous database value to prevent races.
Only public keys are stored; credential-list responses contain metadata only.

Successful logins use the wallet flow's access/refresh token service, session
metadata and new-session alert. Enrolled TOTP still requires its verification
step before a session is issued. Credential changes and anomalies also publish
alerts to the authenticated user stream.

Reference: https://simplewebauthn.dev/docs/packages/server
Rollback: `prisma/rollback/20261008092000_webauthn.sql`.
