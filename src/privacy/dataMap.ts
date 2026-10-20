/**
 * Data-erasure policy per model, applied when a user asks for their data to
 * be erased (e.g. a GDPR "right to be forgotten" request).
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

  // Financial and business records that likely have to be retained
  // (accounting, tax, audit), so they are kept without personal identifiers.
  Transaction: 'ANONYMIZE',
  CostBasisLot: 'ANONYMIZE',
  FiatOrder: 'ANONYMIZE',
  ReferralConversion: 'ANONYMIZE',

  // Append-only or tamper-evident records. Changing them would break the
  // integrity of the log, so they are never altered or erased.
  AuditBlock: 'IMMUTABLE',
  OutboxOp: 'IMMUTABLE',
}
