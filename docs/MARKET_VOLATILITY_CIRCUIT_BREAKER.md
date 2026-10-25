# Market Volatility Circuit Breaker

The agent evaluates each active user's trailing 30-day portfolio risk before
rebalance execution. Annualised volatility at or above
`MARKET_VOLATILITY_BREAKER_THRESHOLD_PCT` (default `75`, in percent) opens a
per-user breaker and suppresses that user's rebalance batches. A later valid
risk evaluation below the threshold resets it. If the risk read fails, the
rebalance is skipped for that evaluation and an operator alert is emitted.

Set `MARKET_VOLATILITY_BREAKER_ENABLED=false` to disable the guard for an
environment. The threshold must be a finite number greater than zero; invalid
configuration fails startup.

Transitions and evaluation failures are logged and sent through the configured
alert channels (`SLACK_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY`, and the always-on
application log). Prometheus exposes the observed-volatility histogram,
activation counter, active portfolio gauge, and failed-evaluation counter at
the protected `/metrics` endpoint. No user identifier is used as a metric label.