# Guardian-Based Account Recovery

This feature restores account access when the owner can no longer use the
wallet-signature login path. It changes the account's Stellar wallet identity;
it does not recover or transfer custodial wallet private keys.

## Policy and eligibility

- The owner must have a verified email address.
- The owner nominates 3–5 active platform users with verified email addresses.
  Each guardian must accept the nomination while signed in; invitations do not
  count toward quorum.
- The configured quorum must be at least 2 and no greater than the guardian
  count. A single guardian can never authorize recovery.
- The cooling-off period is fixed at 72 hours after quorum. It is not
  configurable or bypassable.
- V1 supports platform-user guardians only. External email or phone contacts
  are not accepted as guardians.
- Recovery is for primary account owners. It is not a sub-account recovery
  mechanism.

If guardians become unreachable or decline to act, recovery cannot complete.
Choose reliable guardians and ensure enough of them can be contacted; support
cannot bypass this fail-closed policy.

## Flow

1. The authenticated owner configures guardians with
   `POST /api/v1/recovery/guardians`.
2. Each nominated guardian explicitly accepts with
   `POST /api/v1/recovery/guardians/{id}/accept`.
3. A locked-out claimant starts a request with
   `POST /api/v1/recovery/initiate`, providing the current and proposed new
   Stellar public keys. The route is intentionally unauthenticated because
   the claimant may be locked out. It is protected by the API's authentication
   rate limiter; it does not prove claimant identity.
4. The owner and guardians are alerted by email and, where a user stream is
   connected, a security event. The owner's email includes a single-use,
   random cancellation token. Only its SHA-256 hash is stored. The token can
   cancel the request through
   `POST /api/v1/recovery/{id}/cancel-email` with `{"token":"..."}`.
5. Each accepted guardian independently approves the request with
   `POST /api/v1/recovery/{id}/approve`. Reaching quorum starts the 72-hour
   cooling-off period and triggers another alert.
6. The owner can cancel at any time before completion either from an active
   authenticated session using `POST /api/v1/recovery/{id}/cancel` or with the
   emailed token. Cancellation does not require guardian approval.
7. After quorum and the full delay, a scheduled job rotates the account's
   wallet address to the proposed key, removes its TOTP credential, revokes
   existing sessions and API keys, closes live streams, invalidates user
   caches, and records the outcome in the audit log. The owner must sign in
   with the new wallet and re-enroll two-factor authentication.

The recovery request, each guardian approval, cancellation, and completion are
audit-logged. Notification delivery failures are logged and do not silently
change the request's state.

## Threat model and residual risks

The design limits unilateral takeover: no platform operator can approve a
request, every guardian action is explicit, at least two guardians must agree,
the owner receives alerts, and a cooling-off interval leaves time to cancel.
The email token allows cancellation when the owner has lost wallet access but
still controls the registered email.

This is not proof that the claimant is the original account owner. A claimant
who persuades or compromises the quorum may still succeed, and guardians can
be socially engineered. The verified email channel may also be compromised.
The delay and alerts reduce the chance of an unnoticed takeover but cannot
eliminate these risks. Owners should tell guardians how to verify unexpected
requests out of band and should cancel immediately if an alert is unexpected.

The email token is a bearer secret: anyone who controls the verified mailbox
can cancel recovery. It can only cancel, never approve or complete a request.
Do not forward it or include it in support tickets. It remains valid through
the longest possible cooling-off interval, cannot act on an expired or
completed request, and is cleared when the request reaches a terminal state.

## API reference

The request/response shapes and authentication requirements are specified in
[`openapi.yaml`](./openapi.yaml). Guardian management, status lookup,
acceptance, and approval require a non-impersonated user session; API-key
authentication is not accepted. Initiation and email-token cancellation are
public endpoints and must remain rate-limited.
