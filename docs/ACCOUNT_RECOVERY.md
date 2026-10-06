# Guardian-Based Social Recovery

Recovers **account access** for a primary account owner who cannot sign in — their
sessions and ability to authenticate. It does **not** recover the custodial
wallet's key material; see [Scope and limits](#scope-and-limits).

The flow is a time-delayed social recovery: the owner nominates trusted contacts
while they still have access, and later a claimant reopens the account only if a
quorum of those contacts independently approves and a mandatory delay elapses
uncontested.

Implemented under #535. Service: `src/guardians/service.ts`. Routes:
`src/routes/recovery.ts`. Execution: `src/jobs/guardianRecoverySweep.ts`.

## Lifecycle

```
owner (signed in)                guardian                    claimant          platform job
──────────────────                ─────────                  ─────────          ───────────
PUT  /recovery/policy
POST /recovery/guardians ──────► invite (PENDING)
                                   POST /recovery/invitations/respond ──► ACCEPTED
                                                              
POST /recovery/initiate ──────────────────────────► opens PENDING request
                                                     alerts owner + every
                                                     ACCEPTED guardian
                                                                     guardian POST /recovery/guardian/...
                                                                             approval
                                                                     ┌────────┴────────┐
                                                                 quorum            decline / close
                                                                     │
                                              owner POST /recovery/requests/{id}/cancel
                                                                     │
                                                          delay elapses (executeAfter)
                                                                     │
                                                                     ▼
                                              sweep: revokes every live session,
                                              COMPLETED, owner notified
```

`executeAfter` is stamped **once**, on the request row, by whichever approval
wins the race to quorum. It is derived from the policy at that instant and never
recomputed, so editing the policy mid-flight cannot pull the deadline forward.

## Controls

| Control                | Value                                    | Where it is enforced                                        |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Quorum                 | `>= 2`                                   | `MIN_REQUIRED_APPROVALS`; DB `CHECK`; policy re-read on every access |
| Delay                  | `24–168h`, default `48h`                 | `MIN/MAX_RECOVERY_DELAY_HOURS`; DB `CHECK`; re-checked in `executeRecovery` |
| Guardian cap           | `<= 20`, default `5`                     | `MAX_GUARDIAN_CAP`; service count check                    |
| One live request       | 1 per account                            | Partial unique index `recovery_requests_userId_live_key`   |
| Request expiry         | 30 days                                  | `REQUEST_EXPIRY_DAYS`; swept by the job                    |
| Invite TTL             | 168h                                     | `GUARDIAN_INVITE_TTL_HOURS`                                 |
| Public rate limit      | 10 / 15 min                              | `recoveryRateLimiter` on the three public endpoints        |

### Why the one-live-request index is the load-bearing part

`initiateRecovery` performs **no** read-then-write check for an existing request.
That is deliberate. A pre-insert read still races: two concurrent initiations for
the same wallet both read "none" and both insert. `POST /recovery/initiate` is
public and unauthenticated, so the reachability of that race is not a matter of
luck. The partial unique index is the actual guarantee; a `P2002` from it is
translated into the same generic response as every other non-opening path.

It is **partial** rather than a plain unique constraint on `userId` because a
completed, cancelled, or expired request must never block a future attempt — the
feature exists precisely for accounts that are locked out.

### Anti-enumeration

`POST /recovery/initiate` is unauthenticated: the caller is by definition someone
who cannot sign in. It returns an identical `202` for every valid body, whether or
not the account exists, is a sub-account, has no guardians, already has a live
request, or the insert hit the unique index. Only a structurally invalid body
returns `400`. A response that varied by target would be an oracle for "which
wallets have a recovery setup", and wallets are public on-chain.

The claimant-supplied `reason` is attacker-controlled free text. `sanitizeReason`
strips control characters and truncates to 500 characters. The guardian alert
HTML-escapes it before interpolation; the owner alert omits it from the HTML part
entirely. Neither value is ever placed unescaped into an HTML body.

## Endpoints

Owner endpoints require a session. Platform guardians are authenticated **and**
checked for nomination — `requireAuth` alone is not sufficient, since any account
can hold a token.

| Method | Path                                        | Auth              |
| ------ | ------------------------------------------- | ----------------- |
| GET    | `/recovery/policy`                          | owner             |
| PUT    | `/recovery/policy`                          | owner             |
| GET    | `/recovery/guardians`                       | owner             |
| POST   | `/recovery/guardians`                       | owner             |
| DELETE | `/recovery/guardians/{guardianId}`          | owner             |
| POST   | `/recovery/guardians/{guardianId}/accept`   | platform guardian |
| POST   | `/recovery/invitations/respond`             | external token    |
| POST   | `/recovery/initiate`                        | **none**          |
| GET    | `/recovery/requests/{requestId}`            | owner             |
| POST   | `/recovery/requests/{requestId}/cancel`     | owner             |
| GET    | `/recovery/guardian/requests`               | platform guardian |
| POST   | `/recovery/guardian/requests/{id}/decide`   | platform guardian |
| POST   | `/recovery/guardian/decide`                 | external token    |

### There is no execute endpoint

Execution is not reachable over HTTP, by design. A route would be callable only by
an authenticated user of the account being recovered, and the instant it succeeded
every one of their sessions would be revoked — so the caller would lock themselves
out mid-request and nobody could ever invoke it. Recovery is platform-side work
driven by time, not by a caller. `src/jobs/guardianRecoverySweep.ts` is the only
caller of `executeRecovery`.

## Guardian identity and tokens

Guardians are either `platform` (another verified user, decided from their
session), or external contacts reached by email or phone. Nomination must supply
exactly one identifier; mixing a platform user with an external contact is
rejected.

Invite and decision tokens are returned to the sender **once**, stored only as
SHA-256 digests, and never intentionally logged. A fresh decision token is minted
per request rather than keeping one long-lived token serving both roles, which
widens the exposure window if it leaks from an inbox. Each token is bound to its
request: an old token cannot vote on a new request.

Digest lookup means possessing the token is the proof; no constant-time comparison
is needed on top of it. What matters is that an expired or already-answered token
cannot be reused.

## Alerting

The owner alert is unconditional and emitted **before** any guardian notification
is attempted. If a claimant has compromised every guardian, the owner's alert is
the only thing left standing between that and a takeover, so a failure in one
channel must not suppress the others.

| Audience | Channels                                              |
| -------- | ----------------------------------------------------- |
| Owner    | socket, registered email, registered WhatsApp         |
| Guardian | socket (platform) or email/WhatsApp (external)        |

There is no raw SMS sender in this codebase, so the phone channel is WhatsApp. A
guardian with no reachable channel on file is alerted over whatever channels exist;
the platform does not collect new contact data during a recovery.

Notification failures are logged and swallowed. A mail outage must not roll back a
security action that has already been recorded, and callers should not need a
try/catch around every alert to get that guarantee.

Socket events (`src/events/types.ts`, socket-only — a recovery alert must never be
suppressible by a misconfigured or unsubscribed webhook):

- `security.recovery_initiated`
- `security.recovery_quorum_reached`
- `security.recovery_cancelled`
- `security.recovery_completed`
- `security.guardian_approval_requested`

A guardian sees only their own decision, never who else was asked or what anyone
else said. The owner sees all decisions on their request.

## Execution

The sweep runs two passes per tick: expire requests that aged out before quorum,
then execute requests whose `executeAfter` has passed, capped by
`RECOVERY_SWEEP_BATCH_SIZE`.

- `executeAfter` is re-checked per row, so a bug in the sweep's query cannot
  shorten the mandatory window.
- The transition to `COMPLETED` is a conditional update, so a concurrent
  cancellation cannot be undone and two concurrent sweeps cannot both execute.
- Revocation continues after an individual session fails; a partially revoked
  account is worse than none. One bad request does not strand the rest of the
  batch — it surfaces again on the next tick.
- Cancellation is unilateral and needs no guardian consensus, and it holds until
  execution wins the conditional-update race.

On success every live session for the account is revoked with reason
`account_recovery`. No password is reset and no wallet key is touched — the owner
recovers by signing in again.

## Configuration

| Variable                      | Default   | Meaning                              |
| ----------------------------- | --------- | ------------------------------------ |
| `RECOVERY_SWEEP_INTERVAL_MS`  | `60000`   | Tick interval                        |
| `RECOVERY_SWEEP_BATCH_SIZE`   | `50`      | Requests executed per tick           |
| `RECOVERY_RATE_LIMIT_WINDOW_MS` | `900000` | Public-endpoint window             |
| `RECOVERY_RATE_LIMIT_MAX`     | `10`      | Requests per window per caller       |

The sweep timer is cleared on shutdown (`src/index.ts`).

## Scope and limits

Stated plainly, because a recovery feature's failures are invisible until someone
is locked out:

- **Account access only.** This restores the ability to authenticate. It does not
  recover wallet key material, and it does not undo on-chain transactions.
- **Primary accounts only (v1).** A sub-account's access is delegated by a parent
  account that already exists and already has its own recovery path; routing
  recovery through guardians as well would multiply the ways a child account could
  be taken over. Sub-account requests are refused.
- **No recovery when fewer guardians have accepted than the quorum requires.** If
  nobody can be reached, there is no independent second party, so opening a
  request would only create a row that can never complete. This is the one
  hard-stop failure mode: an owner whose guardians have all dropped off must use
  another path.
- **Not instantaneous.** The minimum 24h delay is the window in which a real owner
  notices and cancels. Recovery cannot be rushed, by anyone.
- **Trust is bootstrapped, not verified.** Anyone an owner nominates can eventually
  help hand over the account. Nomination happens while the owner has access, so it
  is a decision made in a state of clarity.
- **Guardian contact details are masked** in owner-facing responses. Enough to
  recognise your own list, not enough to harvest it — a recovery feature is an
  excellent way to enumerate a target's associates.
- **Audit trail is destroyed on rollback.** Dropping the four tables removes all
  recovery history. Export `recovery_approvals` first if it matters.

## Invariants Prisma cannot express

`prisma/schema.prisma` cannot express CHECK constraints or partial indexes, so
both live only in `prisma/migrations/20260930140000_add_guardian_recovery/migration.sql`.
That makes them invisible to `prisma validate`, to the generated client, and to any
review of the schema alone — precisely the properties that decide whether a
locked-out owner gets their account back safely.

`tests/unit/guardians/structural.test.ts` reads the migration SQL and asserts they
are still present. It is the last line that fails when someone regenerates the
migration from the schema and silently drops what Prisma does not model.