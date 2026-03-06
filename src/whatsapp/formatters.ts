/**
 * WhatsApp Formatter Layer
 * Converts structured API responses into clean, readable WhatsApp messages
 * Uses WhatsApp text formatting: *bold*, _italic_, line breaks
 */

interface PortfolioData {
  totalBalance: string
  totalYield: string
  positions: Array<{
    protocolName: string
    assetSymbol: string
    amount: string
    currentValue: string
    apy: string
  }>
}

interface TransactionData {
  transactions: Array<{
    type: string
    assetSymbol: string
    amount: string
    status: string
    date: string
    txHash?: string
  }>
  hasMore: boolean
  page: number
}

interface TransactionDetailData {
  type: string
  assetSymbol: string
  amount: string
  fee?: string
  status: string
  date: string
  txHash: string
  protocol?: string
  memo?: string
}

interface EarningsData {
  totalEarned: string
  averageApy: string
  period: string
  breakdown: Array<{
    protocol: string
    earned: string
  }>
}

interface ProtocolRatesData {
  protocols: Array<{
    name: string
    asset: string
    apy: string
    tvl?: string
  }>
}

interface AgentStatusData {
  status: string
  lastAction: string
  lastActionTime: string
  successRate: string
}

export const whatsappFormatters = {
  /**
   * Format portfolio balance for WhatsApp
   */
  formatPortfolio: (data: PortfolioData): string => {
    if (!data.positions || data.positions.length === 0) {
      return `💼 *Your Portfolio*\n\n_No active positions_`
    }

    let message = `💼 *Your Portfolio*\n\n`
    message += `💰 *Total Balance:* $${data.totalBalance}\n`
    message += `📈 *Total Yield Earned:* $${data.totalYield}\n\n`
    message += `*Positions:*\n`

    data.positions.forEach((pos, idx) => {
      message += `\n${idx + 1}. *${pos.assetSymbol}* on ${pos.protocolName}\n`
      message += `   Deposited: $${pos.amount}\n`
      message += `   Current Value: $${pos.currentValue}\n`
      message += `   APY: ${pos.apy}%`
    })

    return message
  },

  /**
   * Format transaction history for WhatsApp
   */
  formatTransactionHistory: (data: TransactionData): string => {
    if (!data.transactions || data.transactions.length === 0) {
      return `📋 *Transaction History*\n\n_No transactions found_`
    }

    let message = `📋 *Recent Transactions*\n`
    message += `_(Page ${data.page})_\n\n`

    data.transactions.forEach((tx) => {
      const emoji =
        tx.type === 'DEPOSIT'
          ? '⬇️'
          : tx.type === 'WITHDRAWAL'
            ? '⬆️'
            : tx.type === 'YIELD_CLAIM'
              ? '🎁'
              : '🔄'

      const statusEmoji =
        tx.status === 'CONFIRMED' ? '✅' : tx.status === 'PENDING' ? '⏳' : '❌'

      message += `${emoji} ${tx.type}\n`
      message += `   ${tx.amount} ${tx.assetSymbol}\n`
      message += `   ${statusEmoji} ${tx.status}\n`
      message += `   ${tx.date}\n\n`
    })

    if (data.hasMore) {
      message += `_More transactions available. Reply "next" for more._`
    }

    return message
  },

  /**
   * Format single transaction details for WhatsApp
   */
  formatTransactionDetail: (data: TransactionDetailData): string => {
    const statusEmoji =
      data.status === 'CONFIRMED'
        ? '✅'
        : data.status === 'PENDING'
          ? '⏳'
          : '❌'

    let message = `📊 *Transaction Details*\n\n`
    message += `*Type:* ${data.type}\n`
    message += `*Asset:* ${data.assetSymbol}\n`
    message += `*Amount:* ${data.amount}\n`

    if (data.fee) {
      message += `*Fee:* ${data.fee}\n`
    }

    message += `*Status:* ${statusEmoji} ${data.status}\n`
    message += `*Date:* ${data.date}\n`

    if (data.protocol) {
      message += `*Protocol:* ${data.protocol}\n`
    }

    if (data.memo) {
      message += `*Note:* ${data.memo}\n`
    }

    message += `\n_Hash: ${data.txHash.slice(0, 12)}..._`

    return message
  },

  /**
   * Format earnings summary for WhatsApp
   */
  formatEarnings: (data: EarningsData): string => {
    let message = `💵 *Earnings Report*\n`
    message += `${data.period}\n\n`
    message += `*Total Earned:* $${data.totalEarned}\n`
    message += `*Average APY:* ${data.averageApy}%\n\n`

    if (data.breakdown && data.breakdown.length > 0) {
      message += `*By Protocol:*\n`
      data.breakdown.forEach((item) => {
        message += `• ${item.protocol}: $${item.earned}\n`
      })
    }

    return message
  },

  /**
   * Format available protocols and rates for WhatsApp
   */
  formatProtocolRates: (data: ProtocolRatesData): string => {
    if (!data.protocols || data.protocols.length === 0) {
      return `🏦 *Available Protocols*\n\n_No protocols available_`
    }

    let message = `🏦 *Available Protocols & Rates*\n\n`

    data.protocols.forEach((proto) => {
      message += `*${proto.name}*\n`
      message += `   ${proto.asset}: ${proto.apy}% APY\n`

      if (proto.tvl) {
        message += `   TVL: $${proto.tvl}\n`
      }

      message += `\n`
    })

    return message
  },

  /**
   * Format agent status for WhatsApp
   */
  formatAgentStatus: (data: AgentStatusData): string => {
    const statusEmoji = data.status === 'SUCCESS' ? '✅' : data.status === 'FAILED' ? '❌' : '⏳'

    let message = `🤖 *Agent Status*\n\n`
    message += `${statusEmoji} *Status:* ${data.status}\n`
    message += `*Last Action:* ${data.lastAction}\n`
    message += `*Time:* ${data.lastActionTime}\n`
    message += `*Success Rate:* ${data.successRate}%\n`

    return message
  },

  /**
   * Format deposit confirmation for WhatsApp
   */
  formatDepositConfirmation: (amount: string, asset: string, txHash: string): string => {
    return (
      `✅ *Deposit Initiated*\n\n` +
      `💰 Amount: ${amount} ${asset}\n` +
      `🔗 Hash: ${txHash.slice(0, 12)}...\n\n` +
      `_Waiting for network confirmation..._`
    )
  },

  /**
   * Format withdrawal confirmation for WhatsApp
   */
  formatWithdrawalConfirmation: (amount: string, asset: string, txHash: string): string => {
    return (
      `✅ *Withdrawal Initiated*\n\n` +
      `💰 Amount: ${amount} ${asset}\n` +
      `🔗 Hash: ${txHash.slice(0, 12)}...\n\n` +
      `_Waiting for network confirmation..._`
    )
  },

  /**
   * Format error message for WhatsApp
   */
  formatError: (errorType: string, message: string): string => {
    const emoji = '❌'
    return `${emoji} *Error*\n\n${errorType}\n_${message}_`
  },

  /**
   * Format validation error for WhatsApp
   */
  formatValidationError: (fields: string[]): string => {
    let message = `⚠️ *Invalid Input*\n\n`
    message += `Please check:\n`
    fields.forEach((field) => {
      message += `• ${field}\n`
    })
    return message
  },
}

// Individual exports for easier importing
export const formatBalance = whatsappFormatters.formatPortfolio
export const formatTransactions = whatsappFormatters.formatTransactionHistory
export const formatTransactionDetail = whatsappFormatters.formatTransactionDetail
export const formatEarnings = whatsappFormatters.formatEarnings
export const formatProtocolRates = whatsappFormatters.formatProtocolRates
export const formatAgentStatus = whatsappFormatters.formatAgentStatus
export const formatDeposit = (data: { amount: string; currency: string; walletAddress: string; status: string }) => {
  return `💰 *Deposit Instructions*\n\n` +
         `Send *${data.amount} ${data.currency}* to:\n` +
         `\`${data.walletAddress}\`\n\n` +
         `Status: ${data.status === 'pending' ? '⏳ Pending' : '✅ Confirmed'}\n\n` +
         `_Once sent, your deposit will be processed automatically._`
}
export const formatWithdraw = (data: { amount: string; currency: string; status: string }) => {
  return `💸 *Withdrawal Request*\n\n` +
         `Amount: *${data.amount} ${data.currency}*\n` +
         `Status: ${data.status === 'processing' ? '⏳ Processing' : '✅ Completed'}\n\n` +
         `_Your withdrawal is being processed. You'll receive a confirmation once complete._`
}
export const formatHelp = () => {
  return `🤖 *NeuroWealth AI Agent*\n\n` +
         `*Available Commands:*\n\n` +
         `💰 *balance* - Check your portfolio\n` +
         `⬇️ *deposit [amount] [currency]* - Deposit funds\n` +
         `⬆️ *withdraw [amount] [currency]* - Withdraw funds\n` +
         `💵 *earnings* - View yield earnings\n` +
         `📋 *transactions* - Recent transactions\n` +
         `❓ *help* - Show this message\n\n` +
         `_Example: "deposit 100 USDC"_`
}
