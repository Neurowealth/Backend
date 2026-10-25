# Cross-Channel Digest Notifications (#365)

An opt-in **daily / weekly / monthly portfolio summary** delivered over the
user's chosen channels. Unlike event-triggered alerts (which fire when
something happens), a digest is a *scheduled* "here's how your money did this
period" message — a periodic sanity check a passive user can rely on without
opening the app.

> Cross-channel delivery mechanics (opt-in flows, channel availability) are
> shared with the alert-rule email channel and documented in
> [`NOTIFICATIONS.md`](./NOTIFICATIONS.md). This doc covers the digest feature
> itself: the subscription model, the pure assembler, per-channel rendering,
> the scheduled job, quiet hours, and the API.

---

## 1. Subscription model

A `DigestSubscription` row captures one user's digest preference:

| Field           | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `frequency`     | `DAILY` \| `WEEKLY` \| `MONTHLY`                               |
| `channels`      | `WHATSAPP` \| `TELEGRAM` \| `EMAIL` \| `WEBHOOK` (multi)       |
| `sendHourUtc`   | Preferred send hour, `0..23` (UTC)                             |
| `weeklyDayUtc`  | `0..6` (Sunday=0), required for `WEEKLY`                       |
| `quietHours`    | `{ startUtc, endUtc }` — never send inside this window         |
| `isActive`      | Opt-in switch                                                  |
| `lastSentAt`    | Stamp of the last delivery                                     |
| `nextRunAt`     | Next scheduled occurrence (UTC)                                |

**Opt-in, not opt-out.** A sensible default is offered at onboarding; nothing is
enabled without the user choosing a frequency and at least one channel.

### Channel availability

- **WHATSAPP** — delivered when the user has a phone on file. Reject adding this
  channel at creation if no `phone`; if a linked phone is later removed, the
  channel is skipped for that occurrence with a `digest.channel_unavailable`
  note, never an error.
- **WEBHOOK** — delivered to the user's **own** registered webhook endpoints
  only, as a `digest.generated` event on the user's scoped stream. It is a
  *socket-only* event type, so it can never be routed to an operator webhook
  (see `src/events/types.ts`). Requires at least one active endpoint at
  creation.
- **TELEGRAM / EMAIL** — reserved for their sibling channel issues. Their
  renderers are stubbed in `src/notifications/render.ts`. `EMAIL` delivery is
  described in `NOTIFICATIONS.md` (#367); `TELEGRAM` has no outbound push engine
  yet and is marked unavailable for now.

## 2. The pure assembler — `buildDigest`

`src/notifications/digest.ts` exposes a **pure, deterministic** `buildDigest`
that maps raw period inputs to a channel-agnostic `DigestModel`. It never touches
the DB or the clock; the scheduled job and the preview endpoint both feed it
(`src/notifications/load.ts` fetches the inputs).

The model reports:

- **Portfolio value** now vs. start-of-period, absolute and percent.
- **Yield** earned this period; blended APY; best / worst position.
- **Agent activity**: rebalances this period (count + average net improvement),
  from `RebalanceDecision`.
- **Goal progress** deltas from the goal service (same `onTrack`/APY logic as
  in-app). A `null` delta is honest: historical goal progress isn't persisted.
- **One risk line** — max drawdown over the period, or a "no meaningful
  drawdown" line, or a data-sufficiency note.
- **Notable transactions** over a threshold, capped.

**Honesty discipline** (mirrors the analytics `caveats`): a period with
insufficient `YieldSnapshot` coverage reports the gap as a `caveat` and omits the
misleading delta (`null`), rather than showing a fabricated number. A user with
no positions gets a short "deposit to get started" digest, never an empty or
broken message.

## 3. Channel rendering — `renderDigest`

`src/notifications/render.ts` maps the `DigestModel` onto a channel:

- **WHATSAPP** — concise bold/emoji text sized for chat limits; capped lists say
  "+N more".
- **WEBHOOK** — the structured `DigestModel` JSON is the `digest.generated`
  event payload; no text projection needed.
- **TELEGRAM** — shares the text renderer (no outbound push engine exists yet).
- **EMAIL** — richer HTML/plain render lands with the email-channel issue (#367).

## 4. The scheduled job — `src/jobs/digests.ts`

On each tick the job claims **due, active** subscriptions (`nextRunAt <= now`),
assembles **one** digest per user, and delivers per channel.

- **Atomic claim**: `updateMany` guarded on `{ id, isActive, nextRunAt }`. A
  concurrent runner, mid-tick deactivate, or delete matches 0 rows and is
  skipped — no double-send of the same occurrence.
- **Assemble once, deliver per channel**: one `buildDigest` result is rendered
  and pushed per channel. A failing channel is logged and counted, never
  allowed to block the others, and never rolls the whole occurrence back.
- **Bounded per-channel retry**: transient WHATSAPP failures retry a bounded
  number of times before being marked unavailable for that occurrence.
- **Quiet hours defer, never drop**: if the job fires while the clock is inside
  the window, the occurrence is advanced to the next allowed hour and picked up
  then.
- **Catch-up storm guard**: after a delivery `nextRunAt` advances to the *next*
  future occurrence. A server down for N periods sends exactly **one** digest on
  recovery, not N — `lastSentAt` is a stamp; missed occurrences aren't replayed
  or counted.
- **Occurrence idempotency**: a digest occurrence is `(subscriptionId, slot)`.
  The conditional claim on `nextRunAt` prevents re-runs from double-sending. If
  delivery hard-fails on **all** channels, `nextRunAt` is rolled back so the
  occurrence is retried on a later tick rather than silently advanced past.

## 5. API

All digest endpoints are owner-scoped (the callers' own data) and require auth.
Mounted under `/api/v1/notifications/digests`, plus the unversioned
`/api/notifications/digests` alias.

| Method   | Path                                  | Description                                                    |
| -------- | ------------------------------------- | -------------------------------------------------------------- |
| `POST`   | `/digests`                            | Create a subscription (fails if channels aren't linked).       |
| `GET`    | `/digests`                            | List the caller's subscriptions.                                |
| `GET`    | `/digests/preview?frequency=WEEKLY`   | Render the digest **right now** for the caller, no scheduling (rate-limited). |
| `PATCH`  | `/digests/:id`                        | Update a subscription (validates channel linking + WEEKLY day). |
| `DELETE` | `/digests/:id`                        | Delete a subscription.                                          |

Validation lives in `src/validators/digest-validators.ts`: frequencies/channels
mirror the Prisma enums; `WEEKLY` requires `weeklyDayUtc`; `quietHours` needs
distinct 0..23 bounds.

## 6. Real-time stream & user webhooks

`digest.generated` is a **socket-only** event type mapped to the `alerts` topic.
Publishing it:

1. Appends to the user's durable stream (resumable via `seq`).
2. Broadcasts to live sockets.
3. Enqueues deliveries to the user's **own** webhook endpoints that allow the
   event (string compare against their `events` allowlist — empty = all).

Operator webhooks are never notified (socket-only + `hasWebhookCounterpart`
returns false). See `src/events/types.ts` and `src/services/userWebhookDispatcher.ts`.

## 7. Metrics

The job records `job_success_total` / `job_failure_total` / `job_duration_ms`
under `job_name="digests"` (via `src/utils/job-metrics.ts`), with `due`,
`delivered`, `deferred`, and `skipped` counts in the job log line.

## 8. Edge cases & failure modes

- **No positions** → short "no active positions" digest (`hasPositions: false`).
- **Channel unlinked** (e.g. phone removed) → skipped with a note, not an error.
- **Quiet hours cover the whole day** → deferred to `quietHours.endUtc` the next
  day.
- **DST-ish edge / missed run** → `nextRunAt` in UTC; a missed run sends once on
  recovery (guarded by `lastSentAt` + claim).
- **Very active user** → transaction/rebalance lists are capped (`+N more`).
- **Monthly on the 31st** → `nextOccurrence` clamps to the last day of the month.
- **Idempotency** → `(subscriptionId, slot)` claim prevents double-sends.
