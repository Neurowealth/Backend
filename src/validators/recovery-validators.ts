import { z } from 'zod'

/**
 * Request validation for guardian-based social recovery (#535).
 *
 * Two rules shape everything here:
 *
 *   1. Normalisation is not optional. Guardian identity is a security decision,
 *      so `Guardian@Example.com` and `guardian@example.com` must never become
 *      two guardians, and E.164 phone numbers are stored without punctuation.
 *   2. `POST /recovery/initiate` is a PUBLIC endpoint — the claimant is by
 *      definition someone who cannot authenticate. Its schema is therefore the
 *      main thing standing between an unauthenticated caller and a live recovery
 *      request, and it deliberately carries no token, signature, or caller
 *      identity: the only thing it can do is ring the alarm and start a clock.
 *      That is intentional, and it is why the loud alerting in
 *      src/guardians/notifications.ts is not optional.
 */

/** Guardrails on the free-text `reason`. See `sanitizeReason` in the service. */
const reasonSchema = z
  .string()
  .trim()
  .min(1, 'A reason is required')
  .max(500, 'Reason must be 500 characters or fewer')

const uuidSchema = z.string().uuid()

/** E.164, digits and an optional leading `+` only. */
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[^\d+]/g, ''))
  .refine(
    (v) => /^\+?[1-9]\d{6,14}$/.test(v),
    'Phone number must be E.164, e.g. +14155550123'
  )

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Valid email address is required')

/**
 * Guardian nomination. At least one identifier is required — a row with none of
 * them would be a guardian nobody can ever reach, which silently reduces quorum
 * and is exactly the "all guardians unreachable" failure mode the feature
 * accepts but must not create by accident. The service re-checks this after
 * `.optional()` fields are dropped, because `.refine` cannot see a body where
 * all three keys were omitted.
 */
export const nominateGuardianSchema = z
  .object({
    guardianUserId: uuidSchema.optional(),
    externalEmail: emailSchema.optional(),
    externalPhone: phoneSchema.optional(),
  })
  .refine(
    (v) => Boolean(v.guardianUserId ?? v.externalEmail ?? v.externalPhone),
    {
      message:
        'Provide guardianUserId, externalEmail, or externalPhone to identify the guardian',
      path: ['guardianUserId'],
    }
  )
  .refine(
    (v) =>
      // A guardian is identified EITHER by a platform account OR by external
      // contact details, never by both. Accepting a mixed identity would let
      // one nomination resolve to two different parties depending on which
      // identifier the lookup happened to prefer, and a guardian must be able
      // to answer "is this me?" without ambiguity. Email and phone together are
      // fine: that is one external person with two ways to reach them.
      !(v.guardianUserId && (v.externalEmail || v.externalPhone)),
    {
      message:
        'Identify the guardian either by guardianUserId or by external contact details, not both',
      path: ['guardianUserId'],
    }
  )

/**
 * Guardian accept / decline. Carries the invite token, which is the only proof
 * of identity available to an external contact — a platform guardian is instead
 * expected to accept through their authenticated session
 * (POST /recovery/guardians/:id/accept).
 */
export const respondToGuardianInviteSchema = z.object({
  token: z.string().trim().min(1, 'Invitation token is required').max(200),
  accept: z.boolean({ error: 'accept must be a boolean' }),
})

/**
 * Recovery initiation by a locked-out claimant. Public by design: this is the
 * "I cannot get in" door. `walletAddress` identifies the account being claimed;
 * it is never treated as proof of anything.
 */
export const initiateRecoverySchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .min(1, 'walletAddress is required')
    .max(64, 'walletAddress must be 64 characters or fewer'),
  reason: reasonSchema,
})

/** Recovery policy edit. Bounds mirror the database CHECK constraints. */
export const updateRecoveryPolicySchema = z
  .object({
    requiredApprovals: z
      .number()
      .int()
      .min(
        2,
        'requiredApprovals must be at least 2 — a 1-of-N quorum is never allowed'
      )
      .max(10, 'requiredApprovals must be 10 or fewer')
      .optional(),
    recoveryDelayHours: z
      .number()
      .int()
      .min(24, 'recoveryDelayHours must be at least 24')
      .max(168, 'recoveryDelayHours must be 168 or fewer (7 days)')
      .optional(),
  })
  .refine(
    (v) =>
      v.requiredApprovals !== undefined || v.recoveryDelayHours !== undefined,
    { message: 'Provide at least one policy field to update' }
  )

export const recoveryRequestIdParamSchema = z.object({
  requestId: uuidSchema,
})

export const guardianIdParamSchema = z.object({
  guardianId: uuidSchema,
})

/**
 * A guardian's decision. `approved: false` is a recorded refusal, not a no-op:
 * storing it keeps the decision auditable and stops the guardian being re-asked.
 */
export const approveRecoverySchema = z.object({
  approved: z.boolean({ error: 'approved must be a boolean' }),
  note: z
    .string()
    .trim()
    .max(500, 'Note must be 500 characters or fewer')
    .optional(),
})

/**
 * Out-of-band guardian approval for an EXTERNAL contact, who has no platform
 * session. The token identifies which guardian is deciding, so one guardian can
 * never approve on another's behalf and one token cannot be replayed for a
 * second decision (the (requestId, guardianId) row already exists by then).
 */
export const externalApprovalSchema = z.object({
  requestId: uuidSchema,
  token: z.string().trim().min(1, 'Approval token is required').max(200),
  approved: z.boolean({ error: 'approved must be a boolean' }),
  note: z
    .string()
    .trim()
    .max(500, 'Note must be 500 characters or fewer')
    .optional(),
})

export type NominateGuardianInput = z.infer<typeof nominateGuardianSchema>
export type RespondToGuardianInviteInput = z.infer<
  typeof respondToGuardianInviteSchema
>
export type InitiateRecoveryInput = z.infer<typeof initiateRecoverySchema>
export type UpdateRecoveryPolicyInput = z.infer<
  typeof updateRecoveryPolicySchema
>
export type ApproveRecoveryInput = z.infer<typeof approveRecoverySchema>
export type ExternalApprovalInput = z.infer<typeof externalApprovalSchema>
