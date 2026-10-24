# Guardian-based account access recovery (#535)

This flow recovers the account's **sign-in key**, not custodial wallet key
material. It is deliberately fail-closed: there is no operator or platform
administrator override.

## Setup

An owner nominates between two and five other active platform users. Each
nominee must have a verified email address and must explicitly accept while
signed in before they count toward the policy. The owner chooses a quorum from
two to five; recovery stays unavailable until at least that many eligible
guardians have accepted. The recovery delay is fixed at 72 hours and cannot be
shortened or disabled.

Version 1 supports platform-user guardians only. External email/phone contacts
are not accepted as guardians because the platform has no independent external
guardian identity and approval credential flow. Users should nominate reliable
people who can sign in and respond; if the accepted quorum is unreachable,
recovery cannot complete and the platform cannot bypass it.

## Recovery lifecycle

1. A claimant obtains a nonce for a new Stellar public signing key through
   `/auth/challenge`, signs it, and submits the registered, verified account
   email, key, and signature. The public endpoint returns the same response
   for eligible and ineligible requests to avoid account enumeration.
2. The registered email receives an immediate alert and one-time cancellation
   token. The token remains valid only while the request is pending, so the owner
   can cancel at any time before completion. Every accepted guardian receives an email and must separately sign
   in and approve. Initiation is also emitted to the account's durable/live
   security event stream.
3. Reaching the configured quorum starts a mandatory 72-hour cooling-off
   period. No recovery action is effective before it ends.
4. Until completion, the owner can cancel immediately with any active session
   or with the one-time token sent to the registered email. Guardian consensus
   is not required to cancel.
5. At expiry, the new public key replaces only the account's sign-in key (the
   asset wallet address is unchanged), all existing sessions and refresh
   credentials are revoked, API keys are revoked, and TOTP/passkey credentials
   are reset. The claimant signs in using the normal wallet-signature flow and
   re-enrolls any second factors.

Nomination, acceptance, rejection, revocation, initiation, each approval,
cancellation, and completion are recorded in `AdminAuditLog`. Notifications
are queued through the durable outbound email queue; initiation also emits a
real-time account event.

## Threat model and residual risk

The quorum prevents a single guardian or the platform from unilaterally
recovering an account. The delay plus a registered-email cancellation path
provides the original owner time to notice and stop a takeover. Approval is an
individual action; no bulk or automatic approval exists. A request also fails
closed if it lacks a policy, accepted quorum, a verified registered email, or
an available new signing key.

Guardian collusion or successful social engineering of enough guardians
remains a material risk. Multi-channel alerts and the fixed delay reduce, but
cannot eliminate, that risk. Users should select independent, reachable
guardians and keep their registered email secure. If the registered email is
compromised along with a sufficient guardian quorum, the owner may lose the
ability to cancel in time.

Recovery is for a primary account only. It does not recover a custodial
wallet's private key and does not implement sub-account recovery.

The migration rollback intentionally retains `users.authPublicKey`: copying a
recovered sign-in key back into `walletAddress` would change the user's asset
destination. Because completed credential recoveries cannot be reversed
safely, deployments must not roll back to an application version that only
authenticates against `walletAddress`.
