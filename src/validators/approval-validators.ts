import { z } from 'zod'
import { SubAccountPermission } from '@prisma/client'

const PERMISSION_VALUES = Object.values(SubAccountPermission)

export const approveSchema = z.object({
  note: z.string().max(500).optional(),
})

// A rejection reason is required (optional on approve) — the issue's
// explicit validation rule.
export const rejectSchema = z.object({
  reason: z.string().min(1, 'A reason is required to reject').max(500),
})

export const createApprovalPolicySchema = z.object({
  scopedToChildUserId: z.string().uuid().optional(),
  permission: z.enum(PERMISSION_VALUES as [string, ...string[]]),
  minApprovers: z.number().int().min(1).max(10),
  highValueThreshold: z.number().positive().optional(),
  approvalTimeoutMs: z.number().int().positive(),
})

export const updateApprovalPolicySchema = z.object({
  minApprovers: z.number().int().min(1).max(10).optional(),
  highValueThreshold: z.number().positive().nullable().optional(),
  approvalTimeoutMs: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
})
