export const responses = {
  deposit: (amount: number | string, currency?: string) =>
    `You want to deposit ${amount}${currency ? ' ' + currency : ''}.`,
  withdraw: (amount?: number | string, currency?: string, all?: boolean) => {
    if (all) return 'You want to withdraw everything.'
    return `You want to withdraw ${amount}${currency ? ' ' + currency : ''}.`
  },
  balance: () => 'Here is your current balance.',
  help: () => 'You can ask me to deposit, withdraw, or check your balance.',
  unrecognized: () =>
    "I'm sorry, I couldn't understand that command. Please try 'deposit 100', 'withdraw everything', or 'balance'.",
}
