/**
 * Maps parsed intent actions to human-readable response message generators.
 * Each key corresponds to an `Intent['action']` value and returns the
 * text the bot should reply with for that intent.
 */
export const responses = {
  // Confirms a deposit request, appending the currency code if provided.
  deposit: (amount: number | string, currency?: string) =>
    `You want to deposit ${amount}${currency ? ' ' + currency : ''}.`,

  // Confirms a withdrawal request. Handles the special "withdraw everything"
  // case separately since it has no specific amount to report.
  withdraw: (amount?: number | string, currency?: string, all?: boolean) => {
    if (all) return 'You want to withdraw everything.'
    return `You want to withdraw ${amount}${currency ? ' ' + currency : ''}.`
  },

  // Static response for balance-check requests. Actual balance value is
  // expected to be handled/displayed elsewhere (this is just the intro line).
  balance: () => 'Here is your current balance.',

  // Lists supported commands for users who ask for help or guidance.
  help: () => 'You can ask me to deposit, withdraw, or check your balance.',

  // Fallback response when neither regex nor Claude could classify the
  // message into a known intent (i.e. Intent.action === 'unknown').
  unrecognized: () =>
    "I'm sorry, I couldn't understand that command. Please try 'deposit 100', 'withdraw everything', or 'balance'.",

  // Prompt shown when the parser recognized signals for one or more actions
  // but wasn't confident enough to act on any of them directly (#401) — e.g.
  // a message that could plausibly be a deposit or a withdrawal. `labels` are
  // short human phrases like "deposit money" or "check your balance"; at
  // least one is always provided.
  clarification: (labels: string[]) => {
    if (labels.length === 0) {
      return "I'm not sure what you'd like to do. Could you rephrase that?"
    }

    if (labels.length === 1) {
      return `Did you want to ${labels[0]}? Could you give me a bit more detail?`
    }

    const list =
      labels.length === 2
        ? labels.join(' or ')
        : `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`

    return `Did you mean to ${list}?`
  },
}
