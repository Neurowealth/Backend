export function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- /balance → check your wallet balance',
    '- /deposit <amount> → get deposit instructions',
    '- /withdraw <amount> → withdraw funds (if available)',
    '- /earnings → see your performance',
    '- /help → show this message again',
  ].join('\n')
}

export function formatLinkInstructions(code: string): string {
  return [
    'Your Telegram chat is not linked to an account yet.',
    `Use this one-time link code: ${code}`,
    'Reply with: /link <code> to finish linking.',
  ].join('\n')
}

export function formatBalanceMessage(balance: number, address: string): string {
  return `Your current balance is ${balance.toFixed(2)} XLM.\nWallet: ${address}`
}

export function formatDepositInstruction(
  amount: number,
  address: string
): string {
  return `To deposit, send ${amount.toFixed(2)} XLM to your wallet address:\n${address}`
}

export function formatWithdrawConfirmation(
  amount: number,
  newBalance: number
): string {
  return `Withdrawal request received for ${amount.toFixed(2)} XLM.\nYour new balance will be ${newBalance.toFixed(2)} XLM once processed.`
}
