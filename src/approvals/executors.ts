/**
 * Bridge from the approval service back into the money-moving controllers
 * (#314). This is a separate module — rather than importing
 * `../controllers/transaction-controller` directly from
 * `../approvals/service` — purely to avoid a static circular import:
 * transaction-controller.ts imports `guardOperation` from the approval
 * service, and the approval service needs to invoke the controller's
 * execute* functions once a request crosses its approval threshold. The
 * dynamic `import()` here defers loading transaction-controller.ts until
 * the payload actually needs executing (long after both modules have
 * finished their initial module-load), so neither side has to know about
 * the other at load time.
 */
import type {
  ExecuteDepositResult,
  ExecuteWithdrawResult,
} from '../controllers/transaction-controller'

export type ApprovalPayload =
  | {
      type: 'deposit'
      userId: string
      walletAddress: string
      amount: number
      assetSymbol: string
      memo?: string
      actingAsUserId?: string | null
    }
  | {
      type: 'withdraw'
      userId: string
      walletAddress: string
      amount: number
      assetSymbol: string
      protocolName?: string
      memo?: string
      actingAsUserId?: string | null
    }

/**
 * Re-run an approved payload through the exact same deposit/withdraw path a
 * non-approved call would take ("one implementation, two gates"), tagging
 * the memo so the resulting Transaction is identifiable as approval-gated
 * for audit/tax purposes. `skipApprovalGuard` prevents this execution from
 * re-entering `guardOperation` and creating a second approval request for
 * the request that just got approved.
 */
export async function runApprovedPayload(
  requestId: string,
  payload: ApprovalPayload
): Promise<ExecuteDepositResult | ExecuteWithdrawResult> {
  const { executeDeposit, executeWithdraw } =
    await import('../controllers/transaction-controller')

  const memo = payload.memo
    ? `${payload.memo} (approval:${requestId})`
    : `approval:${requestId}`

  if (payload.type === 'deposit') {
    return executeDeposit({
      userId: payload.userId,
      walletAddress: payload.walletAddress,
      amount: payload.amount,
      assetSymbol: payload.assetSymbol,
      memo,
      actingAsUserId: payload.actingAsUserId,
      skipApprovalGuard: true,
    })
  }

  return executeWithdraw({
    userId: payload.userId,
    walletAddress: payload.walletAddress,
    amount: payload.amount,
    assetSymbol: payload.assetSymbol,
    protocolName: payload.protocolName,
    memo,
    actingAsUserId: payload.actingAsUserId,
    skipApprovalGuard: true,
  })
}
