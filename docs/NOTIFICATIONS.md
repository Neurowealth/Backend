# Outbound Notification Delivery

Email, SMS, WhatsApp, and Telegram sends are persisted in `outbound_notifications`
before provider delivery. The worker polls every 10 seconds, claims rows
atomically, and retries failures with full-jitter exponential backoff. Defaults
are 8 attempts, a 1-second base delay, and a 5-minute maximum delay; configure
these with `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_BASE_DELAY_MS`, and
`NOTIFICATION_MAX_DELAY_MS`.

Successful rows become `DELIVERED`. Exhausted rows become `DEAD` and remain
available for operator review. The admin API requires a key with `dlq:read` or
`dlq:write` scope:

- `GET /api/v1/admin/notifications/dlq` lists dead-letter metadata without exposing message payloads.
- `POST /api/v1/admin/notifications/dlq/:id/retry` requeues one item from its original payload.

Monitor `outbound_notification_attempts_total` and
`outbound_notification_dlq_size`. `OutboundNotificationDLQGrowing` and
`OutboundNotificationRetriesElevated` alert rules point here. Check provider
status and credentials before replaying; a replay sends the original message
again and can duplicate a message if the provider accepted it but its response
was lost.

The `PROCESSING` lease is recovered after five minutes if a worker exits. Apply
the Prisma migration before deploying code that enqueues notifications.# Email Delivery Channel & Notifications (#367)

NeuroWealth supports `EMAIL` as a first-class delivery channel for alert rules, digests, and security notices alongside `WEBHOOK` and `WHATSAPP`.

## Verified Opt-In Requirement

To protect deliverability and prevent spam, email addresses must pass a double opt-in verification flow before receiving notifications:

1. **Request Verification**: `POST /api/v1/notifications/email` with `{ "email": "user@example.com" }`.
   - Sends a verification email with a signed 24h single-use token.
   - Address is set to `status: "PENDING"`.
2. **Confirm Address**: User clicks link `GET /api/v1/notifications/email/verify?token=...`.
   - Address is set to `status: "VERIFIED"`.
   - Email delivery channel can now be selected on alert rules.

---

## Mailer Architecture & Bounce Handling

- **Provider Abstraction (`MailProvider`)**: Supports AWS `SES` and `SMTP` (Nodemailer), selected via `MAIL_PROVIDER` environment variable. Uses a health ledger for automatic failover.
- **Mandatory Plaintext**: All templates generate both HTML and plaintext parts with unsubscribe / manage-preferences links.
- **Provider Webhooks (`POST /api/v1/webhooks/mail`)**: Signature-verified callback endpoint processing bounces and spam complaints. Hard bounces or complaints update status to `BOUNCED` / `COMPLAINED` / `SUPPRESSED` and emit `notification.email_suppressed`.
