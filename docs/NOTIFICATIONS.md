# Email Delivery Channel & Notifications (#367)

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
