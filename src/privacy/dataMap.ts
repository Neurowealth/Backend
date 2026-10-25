/**
 * Data-erasure policy per model, applied when a user asks for their data to
 * be erased (e.g. a GDPR "right to be forgotten" request).
 *
 * This is the single source of truth for erasure coverage: both the admin
 * erasure job (src/jobs/erasureJob.ts) and the approved-request executor
 * (src/compliance/privacyErasure.ts) consume it.
 *
 *  - DELETE:    remove the records outright.
 *  - ANONYMIZE: keep the records but strip or replace anything that identifies
 *               the user, so aggregates and history stay intact.
 *  - IMMUTABLE: never modified or erased, usually because the record is part
 *               of a tamper-evident or append-only log.
 */
export const erasurePolicies = {
  // Operational data with no value once the user is gone, so it is deleted.
  Session: 'DELETE',
  WebhookSubscription: 'DELETE',
  AlertRule: 'DELETE',
  EmailIdentity: 'DELETE',
  UserWebhookEndpoint: 'DELETE',
  UserApiKey: 'DELETE',
  RecurringDepositPlan: 'DELETE',

  // Models holding userId as a scalar with no Prisma relation: cascades never
  // reach them, so they are erased explicitly.
  IdempotencyRecord: 'DELETE',
  CustodialWallet: 'DELETE',
  AlertAck: 'DELETE',
  NotificationPreferenceAuditLog: 'DELETE',
  WebAuthnChallenge: 'DELETE',
  MessageDelivery: 'DELETE',
  UserEvent: 'DELETE',
  UserEventSequence: 'DELETE',

  // Financial and business records that likely have to be retained
  // (accounting, tax, audit), so they are kept without personal identifiers.
  Transaction: 'ANONYMIZE',
  CostBasisLot: 'ANONYMIZE',
  FiatOrder: 'ANONYMIZE',
  ReferralConversion: 'ANONYMIZE',
  User: 'ANONYMIZE',
  LoanLiquidationEvent: 'ANONYMIZE',
  PlatformBadDebt: 'ANONYMIZE',
  CoverageClaim: 'ANONYMIZE',
  UserDataAudit: 'ANONYMIZE',
  TicketMessage: 'ANONYMIZE',
  // Payload is never user input; only the owning userId is replaced.
  OutboxOp: 'ANONYMIZE',

  // Append-only or tamper-evident records. Changing them would break the
  // integrity of the log, so they are never altered or erased.
  AuditBlock: 'IMMUTABLE',
} as const

export type ErasurePolicyKey = keyof typeof erasurePolicies
