# Custom Price & Yield Alert Rules

User-defined rules that proactively notify a user when a market or portfolio
condition they care about is met — e.g. "tell me if Blend's APY drops below 5%"
or "alert me if my portfolio value falls under $1,000".

This is **end-user** alerting and is deliberately distinct from the operator-
facing Prometheus/Grafana alerting in [`OBSERVABILITY.md`](./OBSERVABILITY.md)
(`agent_loop_status`, `cursor_lag_ledgers`, `dlq_size`, …), which watches system
health for on-call engineers rather than portfolio conditions for users.

- Data model: `AlertRule` in [`prisma/schema.prisma`](../prisma/schema.prisma)
- Evaluation core (pure, unit-tested): [`src/services/alertEvaluator.ts`](../src/services/alertEvaluator.ts)
- Scheduled job: [`src/jobs/alertRules.ts`](../src/jobs/alertRules.ts)
- CRUD API: [`src/routes/alerts.ts`](../src/routes/alerts.ts)
- Delivery: reuses [`src/services/webhookDispatcher.ts`](../src/services/webhookDispatcher.ts)
  (webhook) and [`src/whatsapp/formatters.ts`](../src/whatsapp/formatters.ts) (WhatsApp)

## Rule model

A rule is a single condition (compound/multi-condition rules are out of scope
for v1):

| Field             | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `metric`          | `PROTOCOL_APY`, `PORTFOLIO_VALUE`, or `POSITION_DRAWDOWN`            |
| `protocolName`    | required for `PROTOCOL_APY`, rejected for the other metrics         |
| `comparator`      | `LT`, `LTE`, `GT`, `GTE`                                             |
| `threshold`       | compared against the observed value (units below)                   |
| `deliveryChannel` | `WEBHOOK`, `WHATSAPP`, or `BOTH`                                     |
| `cooldownMinutes` | minimum gap between notifications for this rule (default 60)         |
| `lastFiredAt`     | when the rule last fired; drives cooldown                           |
| `isActive`        | inactive rules are never evaluated                                  |

### Units per metric

- **`PROTOCOL_APY`** — threshold and observed value are **percentages**
  (`5` == 5%). `ProtocolRate.supplyApy` is stored as a fraction (`0.05`), so the
  evaluator scales it by 100 before comparing.
- **`PORTFOLIO_VALUE`** — threshold and observed value are the **USD sum of the
  user's ACTIVE positions' `currentValue`**.
- **`POSITION_DRAWDOWN`** — threshold and observed value are a **percentage
  decline from a reference peak** (see below).

## POSITION_DRAWDOWN reference window

"Drawdown" is meaningless without a reference point, so we fix one explicitly:

> Drawdown is measured against the **rolling 30-day peak of the user's total
> portfolio value**.

The peak is the maximum of:

1. every historical whole-portfolio value reconstructed from `YieldSnapshot`
   rows (`principalAmount + yieldAmount`, summed across the user's positions per
   snapshot instant) within the trailing 30 days, and
2. the current total portfolio value.

Including the current value as a candidate means a fresh all-time high reports
**0% drawdown** rather than a spurious decline against a stale sample.

```
drawdown% = max(0, (peak - current) / peak * 100)
```

The window length is `WINDOW_DAYS` in [`src/jobs/alertRules.ts`](../src/jobs/alertRules.ts).

## Evaluation & cooldown

The job runs on a fixed interval (`ALERT_RULES_INTERVAL_MS`, default 60s). On
each tick it loads all `isActive` rules and, for each:

1. Observes the current value for the rule's metric.
2. Checks the comparator against the threshold.
3. If the condition holds, **atomically claims a fire** with an `updateMany`
   guarded on `{ id, isActive, lastFiredAt outside cooldown }`, setting
   `lastFiredAt = now`. Only if that update matches exactly one row does it
   deliver.

The cooldown is essential: a rule sitting right at its threshold would otherwise
fire on every tick. With it, a rule notifies **at most once per
`cooldownMinutes`**. The condition does **not** have to flip false→true again —
if it is still true once the cooldown elapses, the rule re-fires.

### Edge cases

- **Condition true across many ticks** — cooldown suppresses repeats; the rule
  stays active and re-fires after the cooldown if still true.
- **Rule deleted/deactivated mid-tick** — the atomic fire-claim matches 0 rows,
  so delivery is skipped silently (no error, no send to a gone rule).
- **Protocol delisted** — a `PROTOCOL_APY` rule whose protocol has no
  `ProtocolRate` row is **auto-deactivated** (`isActive = false`) with a logged
  reason, rather than evaluated against missing/stale data.

## Delivery & failed-delivery retry policy

Delivery reuses the existing HMAC-signed webhook dispatcher
(`dispatchWebhookEvent('alert_rule.triggered', …)`) and/or the Twilio WhatsApp
sender. No new unsigned delivery path is introduced.

**Decision (per issue #289): alert deliveries reuse `dispatchWebhookEvent`
as-is and get no additional retry sweep beyond its synchronous 3-attempt
exponential backoff (1s/2s/4s).**

Rationale: alerts are about a *live* condition. A separate sweep that later
replays a `FAILED` delivery could fire a stale alert for a condition that has
since reversed. Instead:

- If **all** requested channels hard-fail during a fire, the job **rolls back
  `lastFiredAt`** to its prior value, so the next tick re-evaluates the *current*
  condition and retries if it still holds (bounded by cooldown). A transient
  failure therefore self-heals on the following tick without replaying stale
  data.
- The webhook dispatcher still persists a `WebhookDelivery` row with
  `status = FAILED` for observability, exactly as for every other event.

If durable, at-least-once alert delivery is required later, the follow-up is a
dedicated retry sweep over `FAILED` `WebhookDelivery` rows — explicitly out of
scope here.

## Configuration

| Env var                  | Default | Meaning                              |
| ------------------------ | ------- | ------------------------------------ |
| `ALERT_RULES_INTERVAL_MS`| `60000` | Evaluation tick interval (ms)        |

## Conversational management (WhatsApp)

Alert rules can be managed over WhatsApp via the NLP intents in
[`src/nlp/parser.ts`](../src/nlp/parser.ts) (`alert_create`, `alert_list`,
`alert_delete`), handled in [`src/whatsapp/handler.ts`](../src/whatsapp/handler.ts).
As with the other intents (#281/#282), the intent union, the `KNOWN_ACTIONS`
allowlist, and the handler switch are kept in sync **manually**. WhatsApp-created
rules default to `WHATSAPP` delivery.
