# DLQ Alerting Runbook

## What to Do When DLQ Alert Fires

The Dead-Letter Queue (DLQ) alert fires when the queue size exceeds the configured threshold (default: 50 events). This indicates that recent event processing failures are not being automatically recovered.

### Alert Channels

Alerts are sent through:

- **LOG** (always enabled) - Check application logs at `logs/error.log`
- **SLACK** (optional) - Configured via `SLACK_WEBHOOK_URL` environment variable
- **PAGERDUTY** (optional) - Configured via `PAGERDUTY_ROUTING_KEY` environment variable

### Alert Deduplication

Alerts are deduplicated using a cooldown window (default: 15 minutes). While the queue remains above the threshold:

- First alert is sent immediately
- Subsequent alerts within the cooldown window are suppressed
- Once cooldown expires and queue is still above threshold, a new alert is sent
- When queue drops below threshold, alert state is cleared

### Step 1: Inspect the DLQ

Access the DLQ admin dashboard via the link in the alert (or navigate to `https://admin.neurowealth.io/dlq`):

1. **View Queue Status**
   - Current size (number of events)
   - Breakdown by status: PENDING, RETRIED, RESOLVED
   - Age of oldest pending event

2. **Identify Patterns**
   - Are all failed events of the same type (deposits, withdrawals, rebalances)?
   - Are they from a specific time window?
   - Is there a common error message?

### Step 2: Understand Root Causes

Common reasons for DLQ growth:

#### Temporary Stellar Network Issues

- **Symptom**: Large influx of timeouts or network errors
- **Recovery**: Wait for network to stabilize; queue will auto-recover
- **Action**: Monitor logs and wait for next retry cycle

#### Smart Contract Issues

- **Symptom**: Errors like "contract not found" or "method invocation failed"
- **Recovery**: Fix contract deployment or method implementation
- **Action**: Deploy fix, then retry events

#### Database Connectivity

- **Symptom**: Connection pool exhausted or query timeouts
- **Recovery**: Restart database or scale read replicas
- **Action**: Resolve DB issue, restart app, then retry

#### Configuration Errors

- **Symptom**: Invalid keys, tokens, or missing environment variables
- **Recovery**: Verify and correct configuration
- **Action**: Update env vars, restart app, then retry

### Step 3: Dry-Run Retry (Optional)

Before retrying all events, inspect a sample event to understand the failure:

```bash
# View a specific event
curl https://api.neurowealth.io/admin/dlq/events/{EVENT_ID}

# Response includes:
# - eventType: "deposit", "withdraw", "rebalance"
# - error: Error message
# - payload: Original event data
# - status: "PENDING", "RETRIED", "RESOLVED"
# - retryCount: Number of retry attempts
```

### Step 4: Manual Retry

Once the root cause is fixed:

```bash
# Retry all pending/retried events
POST /admin/dlq/retry
{
  "dryRun": false,  # Set to true for dry-run
  "statuses": ["PENDING", "RETRIED"]  # Optional filter
}

# Response:
# {
#   "resolved": 45,  # Successfully retried
#   "failed": 5      # Still failing
# }
```

### Step 5: Resolve Events Manually (If Needed)

For events that cannot be recovered:

```bash
# Mark event as resolved (won't be retried)
POST /admin/dlq/events/{EVENT_ID}/resolve

# This is a last resort. Resolved events are not processed
# but won't trigger alerts.
```

### Step 6: Monitor Recovery

After retry:

- Watch the queue size via the dashboard
- Check logs for any new failures
- Monitor the `dlq_size` Prometheus metric
- Alert should clear once queue drops below threshold

## Alert Threshold Configuration

Adjust the alerting threshold via environment variables:

```bash
# Alert when DLQ size >= this value (default: 50)
DLQ_ALERT_THRESHOLD=50

# Suppress duplicate alerts for this duration in milliseconds
# (default: 900000 = 15 minutes)
DLQ_ALERT_COOLDOWN_MS=900000
```

## External Integrations

### Slack Integration

1. Create a Slack App: https://api.slack.com/apps
2. Enable Incoming Webhooks
3. Create a webhook for your channel
4. Set environment variable:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Alert format includes:

- Queue size and breakdown by status
- Age of oldest pending event
- Link to admin dashboard
- Custom metadata

### PagerDuty Integration

1. Create an integration key in PagerDuty
2. Set environment variable:

```bash
PAGERDUTY_ROUTING_KEY=your-pagerduty-routing-key
```

Alerts are deduplicated by minute to prevent incident spam.

## Prometheus Metrics

Monitor alert state via:

```promql
# 1 = alert active, 0 = alert inactive
dlq_alert_active

# Current DLQ size
dlq_size

# DLQ size trend over time
rate(dlq_size[5m])
```

## Prevention Best Practices

1. **Monitor Trends**: Watch `dlq_size` over time for slow growth
2. **Set Lower Thresholds**: Use `DLQ_ALERT_THRESHOLD=20` in staging
3. **Upstream Resilience**: Implement circuit breakers for external APIs
4. **Test Error Handling**: Regularly test DLQ recovery with chaos engineering
5. **On-Call Training**: Ensure on-call engineers understand this runbook

## Alert Severity Levels

- **CRITICAL** (red): DLQ >= threshold, immediate action needed
- **WARNING** (yellow): DLQ between 50% and threshold, investigate soon
- **INFO** (blue): DLQ growing but normal, monitor trend

## Escalation

If queue continues to grow after recovery attempts:

1. **Check Consensus**: Are deposits/withdrawals actually failing on-chain?
2. **Inspect Ledger**: Query Stellar testnet/mainnet for transaction status
3. **Contact Support**: Reach out to Stellar developer relations if contract issue
4. **Page On-Call**: If user-facing transactions are failing, escalate to on-call team

## Related Documentation

- [OBSERVABILITY.md](./OBSERVABILITY.md) - Complete metrics and alert thresholds
- [API_REFERENCE.md](./API_REFERENCE.md) - Admin DLQ endpoints
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Configuration and secrets management
