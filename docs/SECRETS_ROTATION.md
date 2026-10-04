# Secret Inventory and Rotation

Never store secret values in this inventory, logs, or pull requests. Required
runtime secrets are held in AWS Systems Manager Parameter Store under
`SSM_PREFIX` (default `/neurowealth`) when `SECRET_BACKEND=aws-ssm`; environment
variables remain supported for local development and deployment injection.

| Secret | Consumers | Validation | Rotation notes |
|---|---|---|---|
| `JWT_SEED` | Access-token signing and verification | At least 32 characters | New tokens use the refreshed key; the prior key remains verification-only until removed from `JWT_PREVIOUS_SEEDS` after the token lifetime. |
| `WALLET_ENCRYPTION_KEY` | Encrypted wallet material | Exactly 32 bytes as 64 hex characters | Use the wallet key registry and re-encrypt stored material before retiring an old key. |
| `WALLET_ENCRYPTION_KEY_OLD` | Temporary fallback decryption during key rotation | Exactly 32 bytes as 64 hex characters | Keep the prior key only for the re-encryption window, then remove it after all records use the new key. |
| `STELLAR_AGENT_SECRET_KEY` | Stellar transaction signer | Stellar secret-key shape | Verify the replacement signer has the expected network permissions and XLM reserve before rollout. |
| `ANTHROPIC_API_KEY` | AI request provider | `sk-ant-` prefix | Validate the replacement with the provider before rollout. |
| `TWILIO_AUTH_TOKEN` | Twilio client and WhatsApp webhook signature validation | At least 32 characters | Keep old/new credentials accepted during provider transition; refresh recreates the cached Twilio client. |
| `DATABASE_URL` | Prisma/PostgreSQL | PostgreSQL URL | Use overlapping database credentials and a rolling deployment; established Prisma connections do not switch credentials in place. |

Optional provider secrets include `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,

AWS access must come from workload identity or deployment-provided credentials;
do not store credentials needed to read SSM inside that same SSM parameter path.

Optional SSM-managed provider credentials are fetched at startup when present
and refreshed with the required secret set; absent optional parameters do not
prevent startup. The required secrets and the optional list above are the
current inventory for the integrations owned by this service.
`SMTP_PASS`, `SMTP_WEBHOOK_SECRET`, `AWS_ACCESS_KEY_ID`, `OPENAI_API_KEY`, and
`DEEPGRAM_API_KEY`. Add each to the deployment's secret manager and owner-run
rotation schedule before enabling that provider.

## Procedure

1. Confirm the secret owner, service dependencies, rollback value, and an expiry timestamp. Set `SECRET_EXPIRY_<KEY>` to an ISO-8601 timestamp when the provider supplies an expiration date.
2. Create the replacement in the provider and Parameter Store without removing the active credential. For signing/encryption keys, follow the key-version registry and token-lifetime requirements above.
3. Deploy or refresh the SSM-backed service. Values are refreshed every five minutes and copied into runtime configuration; prior JWT signing keys remain verification-only during the overlap. Twilio clients are recreated on credential change. Database pool credentials and already-created third-party clients may require a rolling restart.
4. Confirm `secret_credential_validation_failures` is zero and exercise a provider health check or a low-risk operation. Do not print secret values during validation.
5. Revoke the old credential only after all replicas use the replacement and the rollback window has closed. Record the rotation date and owner in the deployment's approved secret inventory.

Startup validation rejects missing or malformed required values for the SSM
backend. Keep active JWT keys in `JWT_PREVIOUS_SEEDS` across replica restarts
until their tokens expire. Periodic checks also report missing, malformed, or expired configured
values; the `SecretCredentialValidationFailed` alert links to this procedure.