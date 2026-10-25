import { Prisma, SubAccountPermission } from '@prisma/client'
import db from '../db'
import { BulkSubAccountOp } from '../validators/sub-account-bulk-validators'

type Database = typeof db | Prisma.TransactionClient
export class SubAccountManagementError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
  }
}

export async function createSubAccount(
  parentUserId: string,
  input: {
    childUserId: string
    permissions: SubAccountPermission[]
    dailyLimit?: number
    transactionLimit?: number
  },
  database: Database = db
) {
  const { childUserId, permissions, dailyLimit, transactionLimit } = input
  if (parentUserId === childUserId)
    throw new SubAccountManagementError(
      'Cannot create sub-account with yourself',
      400
    )
  const child = await database.user.findUnique({
    where: { id: childUserId },
    select: { id: true },
  })
  if (!child) throw new SubAccountManagementError('Child user not found', 404)
  if (
    await database.subAccount.findFirst({
      where: { parentUserId: childUserId, status: 'ACTIVE' },
      select: { id: true },
    })
  )
    throw new SubAccountManagementError(
      'Chained sub-account relationships are not allowed',
      400
    )
  const existing = await database.subAccount.findUnique({
    where: { parentUserId_childUserId: { parentUserId, childUserId } },
  })
  if (existing?.status === 'ACTIVE')
    throw new SubAccountManagementError(
      'Sub-account relationship already exists',
      409
    )
  const data = {
    permissions,
    ...(dailyLimit !== undefined ? { dailyLimit } : {}),
    ...(transactionLimit !== undefined ? { transactionLimit } : {}),
  }
  return existing
    ? database.subAccount.update({
        where: { id: existing.id },
        data: { ...data, status: 'ACTIVE', revokedAt: null },
      })
    : database.subAccount.create({
        data: { parentUserId, childUserId, ...data },
      })
}

export async function updateSubAccount(
  parentUserId: string,
  target: { childUserId?: string; subAccountId?: string },
  input: Prisma.SubAccountUpdateInput,
  database: Database = db
) {
  const subAccount = await database.subAccount.findUnique({
    where: target.subAccountId
      ? { id: target.subAccountId }
      : {
          parentUserId_childUserId: {
            parentUserId,
            childUserId: target.childUserId!,
          },
        },
  })
  if (!subAccount)
    throw new SubAccountManagementError('Sub-account not found', 404)
  if (subAccount.parentUserId !== parentUserId)
    throw new SubAccountManagementError('Forbidden', 403)
  return database.subAccount.update({
    where: { id: subAccount.id },
    data: input,
  })
}

export async function applySubAccountOperation(
  parentUserId: string,
  op: BulkSubAccountOp,
  database: Database = db
) {
  if (op.action === 'create')
    return createSubAccount(
      parentUserId,
      { childUserId: op.childUserId, ...op.payload },
      database
    )
  return updateSubAccount(
    parentUserId,
    op,
    op.action === 'revoke'
      ? { status: 'REVOKED', revokedAt: new Date() }
      : op.payload,
    database
  )
}
