import { Prisma } from '@prisma/client'
import db from '../db'
import { scoreTransaction, TransactionTypeLike } from '../compliance/scoring'
import { getOrCreateReferralCode } from '../referral/service'

const HOLD_SCORE = 70
const ACTIVE_CASE_STATUSES = [
  'OPEN',
  'TRIAGE',
  'INVESTIGATING',
  'ESCALATED',
  'PENDING_SAR',
] as const

export class InternalTransferError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = 'InternalTransferError'
  }
}

type TransferInput = {
  senderUserId: string
  recipientHandle: string
  amount: string | number
  assetSymbol: string
  note?: string
  acknowledgeGoalImpact?: boolean
}

type TransferPosition = {
  id: string
  protocolName: string
  assetAddress: string | null
  currentValue: Prisma.Decimal
  depositedAmount: Prisma.Decimal
  yieldEarned: Prisma.Decimal
}

function accountIsFrozen(user: { isActive: boolean }, hasActiveCase: boolean) {
  return !user.isActive || hasActiveCase
}

/**
 * Move beneficial ownership of an existing position balance between users.
 * No Stellar operation is created: both position legs, transaction history,
 * tax-lot ownership, and audit events commit in one database transaction.
 */
export async function executeInternalTransfer(input: TransferInput) {
  const amount = new Prisma.Decimal(input.amount)
  if (!amount.isFinite() || amount.lte(0)) {
    throw new InternalTransferError('Amount must be greater than zero', 400)
  }

  return db.$transaction(
    async (tx) => {
      const normalizedHandle = input.recipientHandle.trim().toUpperCase()
      const referralCode = await tx.referralCode.findUnique({
        where: { code: normalizedHandle },
        include: {
          owner: {
            select: {
              id: true,
              network: true,
              isActive: true,
              createdAt: true,
              referralCode: { select: { code: true } },
            },
          },
        },
      })
      if (!referralCode) {
        throw new InternalTransferError('Recipient not found', 404)
      }

      const recipient = referralCode.owner
      if (recipient.id === input.senderUserId) {
        throw new InternalTransferError('Self-transfers are not allowed', 400)
      }

      const sender = await tx.user.findUnique({
        where: { id: input.senderUserId },
        select: { id: true, network: true, isActive: true, createdAt: true },
      })
      if (!sender) {
        throw new InternalTransferError('Sender account not found', 404)
      }
      if (sender.network !== recipient.network) {
        throw new InternalTransferError(
          'Transfers require accounts on the same network',
          409
        )
      }

      const userIds = [sender.id, recipient.id].sort()
      for (const userId of userIds) {
        // Share the same lock key as withdrawals; also lock the recipient so
        // concurrent withdrawals cannot spend a credit before it commits.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${input.assetSymbol}))`
      }

      const [users, activeCases] = await Promise.all([
        tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, isActive: true },
        }),
        tx.complianceCase.findMany({
          where: {
            userId: { in: userIds },
            status: { in: [...ACTIVE_CASE_STATUSES] },
          },
          select: { userId: true },
        }),
      ])
      const frozenUserIds = new Set(
        activeCases.map((caseRow) => caseRow.userId)
      )
      const isFrozen = (userId: string) => {
        const user = users.find((item) => item.id === userId)
        return !user || accountIsFrozen(user, frozenUserIds.has(userId))
      }
      if (isFrozen(sender.id) || isFrozen(recipient.id)) {
        throw new InternalTransferError(
          'Transfers are unavailable for a frozen account',
          423
        )
      }

      const parentLink = await tx.subAccount.findUnique({
        where: {
          parentUserId_childUserId: {
            parentUserId: sender.id,
            childUserId: recipient.id,
          },
        },
        select: { status: true, permissions: true },
      })
      if (
        parentLink &&
        (parentLink.status !== 'ACTIVE' ||
          !parentLink.permissions.includes('DEPOSIT'))
      ) {
        throw new InternalTransferError(
          'Recipient sub-account does not allow deposits from this parent',
          403
        )
      }

      const [history, previousTransfers] = await Promise.all([
        tx.transaction.findMany({
          where: { userId: sender.id },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: {
            type: true,
            amount: true,
            assetSymbol: true,
            createdAt: true,
          },
        }),
        tx.internalTransfer.findMany({
          where: { senderUserId: sender.id },
          select: { recipientHandle: true },
        }),
      ])
      const supportedTypes: TransactionTypeLike[] = [
        'DEPOSIT',
        'WITHDRAWAL',
        'YIELD_CLAIM',
        'REBALANCE',
        'SWAP',
        'REFERRAL_REWARD',
        'INTERNAL_TRANSFER',
      ]
      const now = new Date()
      const score = scoreTransaction({
        transaction: {
          id: 'internal-transfer-preview',
          userId: sender.id,
          type: 'INTERNAL_TRANSFER',
          amount: amount.toNumber(),
          assetSymbol: input.assetSymbol,
          createdAt: now,
          destinationAddress: normalizedHandle,
          isAgentDriven: false,
        },
        account: {
          userId: sender.id,
          accountCreatedAt: sender.createdAt,
          knownDestinationAddresses: [
            ...previousTransfers.map((transfer) => transfer.recipientHandle),
          ],
          transactionHistory: history
            .filter((transaction) =>
              supportedTypes.includes(transaction.type as TransactionTypeLike)
            )
            .map((transaction) => ({
              type: transaction.type as TransactionTypeLike,
              amount: Number(transaction.amount),
              assetSymbol: transaction.assetSymbol,
              createdAt: transaction.createdAt,
              isAgentDriven: transaction.type === 'REBALANCE',
            })),
        },
      })
      if (score.totalScore >= HOLD_SCORE) {
        throw new InternalTransferError(
          'Transfer held for compliance review',
          409
        )
      }

      await tx.$queryRaw`
        SELECT "id" FROM "positions"
        WHERE "userId" = ${sender.id}
          AND "assetSymbol" = ${input.assetSymbol}
          AND "status" = 'ACTIVE'
        ORDER BY "id"
        FOR UPDATE
      `
      const positions = (await tx.position.findMany({
        where: {
          userId: sender.id,
          assetSymbol: input.assetSymbol,
          status: 'ACTIVE',
          liquidityLocked: false,
          collateralLoans: { none: { status: 'ACTIVE' } },
        },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          protocolName: true,
          assetAddress: true,
          currentValue: true,
          depositedAmount: true,
          yieldEarned: true,
        },
      })) as TransferPosition[]
      const pendingWithdrawals = await tx.transaction.aggregate({
        where: {
          userId: sender.id,
          assetSymbol: input.assetSymbol,
          type: 'WITHDRAWAL',
          status: 'PENDING',
        },
        _sum: { amount: true },
      })
      if (new Prisma.Decimal(pendingWithdrawals._sum.amount ?? 0).gt(0)) {
        throw new InternalTransferError(
          'Transfers are unavailable while a withdrawal is pending',
          409
        )
      }
      const positionBalance = positions.reduce(
        (sum, position) => sum.plus(position.currentValue),
        new Prisma.Decimal(0)
      )
      const available = positionBalance
      if (available.lt(amount)) {
        throw new InternalTransferError(
          'Insufficient available balance after pending withdrawal reservations',
          409
        )
      }

      const activeGoals = await tx.savingsGoal.findMany({
        where: { userId: sender.id, status: 'ACTIVE' },
        select: { targetAmount: true },
      })
      if (
        !input.acknowledgeGoalImpact &&
        activeGoals.some((goal) =>
          positionBalance.minus(amount).lt(goal.targetAmount)
        )
      ) {
        throw new InternalTransferError(
          'Transfer would reduce the balance below an active savings goal',
          409
        )
      }

      const plan: Array<{
        position: TransferPosition
        amount: Prisma.Decimal
        principal: Prisma.Decimal
        yield: Prisma.Decimal
      }> = []
      let remaining = amount
      for (const position of positions) {
        if (remaining.lte(0)) break
        if (position.currentValue.lte(0)) continue
        const debit = Prisma.Decimal.min(position.currentValue, remaining)
        const ratio = debit.div(position.currentValue)
        plan.push({
          position,
          amount: debit,
          principal: position.depositedAmount.mul(ratio),
          yield: position.yieldEarned.mul(ratio),
        })
        remaining = remaining.minus(debit)
      }

      const senderHandle = await getOrCreateReferralCode(sender.id, tx)
      const transfer = await tx.internalTransfer.create({
        data: {
          senderUserId: sender.id,
          recipientUserId: recipient.id,
          senderHandle: senderHandle.code,
          recipientHandle: normalizedHandle,
          assetSymbol: input.assetSymbol,
          amount,
          note: input.note?.trim() || null,
          riskScore: score.totalScore,
        },
      })
      const senderTransaction = await tx.transaction.create({
        data: {
          userId: sender.id,
          internalTransferId: transfer.id,
          type: 'INTERNAL_TRANSFER',
          status: 'CONFIRMED',
          assetSymbol: input.assetSymbol,
          amount,
          network: sender.network,
          memo: input.note?.trim() || null,
          confirmedAt: now,
        },
      })

      const destinationPositions = new Map<string, string>()
      for (const item of plan) {
        const debited = await tx.position.updateMany({
          where: {
            id: item.position.id,
            currentValue: { gte: item.amount },
          },
          data: {
            currentValue: { decrement: item.amount },
            depositedAmount: { decrement: item.principal },
            yieldEarned: { decrement: item.yield },
          },
        })
        if (debited.count !== 1) {
          throw new InternalTransferError(
            'Position balance changed during transfer; retry the request',
            409
          )
        }
        const key = item.position.protocolName
        let destinationId = destinationPositions.get(key)
        if (!destinationId) {
          const destination = await tx.position.findFirst({
            where: {
              userId: recipient.id,
              protocolName: key,
              assetSymbol: input.assetSymbol,
              status: 'ACTIVE',
            },
            select: { id: true },
          })
          if (destination) {
            destinationId = destination.id
            destinationPositions.set(key, destination.id)
          } else {
            const created = await tx.position.create({
              data: {
                userId: recipient.id,
                protocolName: key,
                assetSymbol: input.assetSymbol,
                assetAddress: item.position.assetAddress,
                depositedAmount: 0,
                currentValue: 0,
                yieldEarned: 0,
              },
              select: { id: true },
            })
            destinationId = created.id
            destinationPositions.set(key, created.id)
          }
        }
        await tx.position.update({
          where: { id: destinationId },
          data: {
            currentValue: { increment: item.amount },
            depositedAmount: { increment: item.principal },
            yieldEarned: { increment: item.yield },
          },
        })
      }

      const lots = await tx.costBasisLot.findMany({
        where: {
          userId: sender.id,
          assetSymbol: input.assetSymbol,
          remainingAmount: { gt: 0 },
        },
        orderBy: [{ acquiredAt: 'asc' }, { id: 'asc' }],
      })
      const principalToMove = Prisma.Decimal.min(
        amount,
        Prisma.Decimal.max(
          new Prisma.Decimal(0),
          plan.reduce(
            (sum, item) => sum.plus(item.principal),
            new Prisma.Decimal(0)
          )
        )
      )
      let taxAmountRemaining = principalToMove
      for (const lot of lots) {
        if (taxAmountRemaining.lte(0)) break
        const lotAmount = Prisma.Decimal.min(
          lot.remainingAmount,
          taxAmountRemaining
        )
        await tx.costBasisLot.update({
          where: { id: lot.id },
          data: { remainingAmount: { decrement: lotAmount } },
        })
        const recipientTransaction = await tx.transaction.create({
          data: {
            userId: recipient.id,
            internalTransferId: transfer.id,
            type: 'INTERNAL_TRANSFER',
            status: 'CONFIRMED',
            assetSymbol: input.assetSymbol,
            amount: lotAmount,
            network: recipient.network,
            confirmedAt: now,
          },
        })
        await tx.costBasisLot.create({
          data: {
            userId: recipient.id,
            transactionId: recipientTransaction.id,
            assetSymbol: input.assetSymbol,
            originalAmount: lotAmount,
            remainingAmount: lotAmount,
            acquisitionPrice: lot.acquisitionPrice,
            priceSource: lot.priceSource,
            acquiredAt: lot.acquiredAt,
          },
        })
        taxAmountRemaining = taxAmountRemaining.minus(lotAmount)
      }

      const lotAmountsMoved = principalToMove.minus(taxAmountRemaining)
      const untaxedAmount = amount.minus(lotAmountsMoved)
      if (untaxedAmount.gt(0)) {
        const recipientTransaction = await tx.transaction.create({
          data: {
            userId: recipient.id,
            internalTransferId: transfer.id,
            type: 'INTERNAL_TRANSFER',
            status: 'CONFIRMED',
            assetSymbol: input.assetSymbol,
            amount: untaxedAmount,
            network: recipient.network,
            confirmedAt: now,
          },
        })
      }

      await tx.adminAuditLog.createMany({
        data: [
          {
            adminName: sender.id,
            action: 'P2P_TRANSFER_SENT',
            target: recipient.id,
            result: 'ok',
            details: {
              transferId: transfer.id,
              assetSymbol: input.assetSymbol,
              amount: amount.toString(),
              riskScore: score.totalScore,
            },
          },
          {
            adminName: recipient.id,
            action: 'P2P_TRANSFER_RECEIVED',
            target: sender.id,
            result: 'ok',
            details: {
              transferId: transfer.id,
              assetSymbol: input.assetSymbol,
              amount: amount.toString(),
              riskScore: score.totalScore,
            },
          },
        ],
      })

      return {
        transferId: transfer.id,
        transactionId: senderTransaction.id,
        recipientHandle: normalizedHandle,
        assetSymbol: input.assetSymbol,
        amount: amount.toString(),
        riskScore: score.totalScore,
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  )
}
