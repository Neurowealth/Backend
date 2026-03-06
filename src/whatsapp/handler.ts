import { parseIntent } from '../nlp/parser';
import userManager from './userManager';
import db from '../db';

export async function handleWhatsAppMessage(from: string, message: string): Promise<string> {
  const phone = from.replace(/^whatsapp:/, '');
  // ensure user exists (or create)
  const user = await userManager.getOrCreateUser(phone);

  // onboarding / OTP flow
  if (!user.isActive) {
    const trimmed = message.trim();
    // if user enters exactly 6 digits, treat as OTP attempt
    if (/^\d{6}$/.test(trimmed)) {
      const ok = await userManager.verifyOtpCode(phone, trimmed);
      if (ok) {
        return '✅ Your phone number is verified! You can now send commands like "balance", "deposit 100", or "withdraw 50".';
      } else {
        // maybe expired or wrong, ask to resend
        const newCode = await userManager.generateAndSaveOtp(phone);
        return `❌ Invalid or expired code. I've sent you a new OTP: ${newCode} (expires in 5 minutes).`;
      }
    }

    // otherwise, send OTP to new user
    const otp = await userManager.generateAndSaveOtp(phone);
    return `Welcome to NeuroWealth! To get started we need to verify your phone number. Please reply with this 6-digit code: ${otp} (valid for 5 minutes).`;
  }

  // active user – parse intent
  const intent = await parseIntent(message);

  switch (intent.action) {
    case 'balance': {
      const balance = await userManager.calculateBalance(phone);
      return `💰 Your current portfolio value is ${balance.toFixed(2)} XLM (approx).`;
    }

    case 'deposit': {
      if (!intent.amount || intent.amount <= 0) {
        return 'Please specify an amount to deposit, e.g. "deposit 100".';
      }
      const currency = intent.currency || 'XLM';
      // create a pending transaction record for bookkeeping
      await db.transaction.create({
        data: {
          userId: user.id,
          type: 'DEPOSIT',
          assetSymbol: currency,
          amount: intent.amount,
          network: user.network,
        },
      });
      return `To deposit ${intent.amount} ${currency}, send funds to your Stellar wallet ${user.walletAddress}. \nOnce confirmed, your balance will update automatically.`;
    }

    case 'withdraw': {
      if (intent.all) {
        const bal = await userManager.calculateBalance(phone);
        if (bal <= 0) {
          return "You don't have any funds available to withdraw.";
        }
        // create a withdrawal request
        await db.transaction.create({
          data: {
            userId: user.id,
            type: 'WITHDRAWAL',
            assetSymbol: 'XLM',
            amount: bal,
            network: user.network,
            status: 'PENDING',
          },
        });
        return `Your request to withdraw all (${bal.toFixed(2)} XLM) has been received and is being processed.`;
      }

      if (!intent.amount || intent.amount <= 0) {
        return 'Please specify an amount to withdraw, e.g. "withdraw 50" or "withdraw all".';
      }

      const bal = await userManager.calculateBalance(phone);
      if (intent.amount > bal) {
        return `You requested ${intent.amount} but only have ${bal.toFixed(2)} available.`;
      }
      await db.transaction.create({
        data: {
          userId: user.id,
          type: 'WITHDRAWAL',
          assetSymbol: intent.currency || 'XLM',
          amount: intent.amount,
          network: user.network,
          status: 'PENDING',
        },
      });
      return `Your withdrawal of ${intent.amount} ${intent.currency || 'XLM'} is being processed.`;
    }

    // help and unknown both send help text
    case 'help':
    case 'unknown':
    default: {
      return `I can help you manage your funds. Send:
- "balance" to see your portfolio
- "deposit 100" to get deposit instructions
- "withdraw 50" or "withdraw all" to request a withdrawal`;
    }
  }
}
