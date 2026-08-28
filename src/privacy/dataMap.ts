export const erasurePolicies = {
  Session: 'DELETE',
  WebhookSubscription: 'DELETE',
  AlertRule: 'DELETE',
  Transaction: 'ANONYMIZE',
  CostBasisLot: 'ANONYMIZE',
  FiatOrder: 'ANONYMIZE',
  ReferralConversion: 'ANONYMIZE',
  AuditBlock: 'IMMUTABLE',
  OutboxOp: 'IMMUTABLE',
};
