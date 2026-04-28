import { z } from 'zod';
import { Network } from '@prisma/client';

export const DepositEventSchema = z.object({
  user: z.string().min(1, "User wallet address is required"),
  amount: z.string().refine(val => !isNaN(Number(val)) && Number(val) >= 0, {
    message: "Amount must be a non-negative number string",
  }),
  shares: z.string().refine(val => !isNaN(Number(val)) && Number(val) >= 0, {
    message: "Shares must be a non-negative number string",
  }),
  assetSymbol: z.string().min(1, "Asset symbol is required"),
  protocolName: z.string().min(1, "Protocol name is required"),
  network: z.nativeEnum(Network),
});

export const WithdrawEventSchema = z.object({
  user: z.string().min(1, "User wallet address is required"),
  amount: z.string().refine(val => !isNaN(Number(val)) && Number(val) >= 0, {
    message: "Amount must be a non-negative number string",
  }),
  shares: z.string().refine(val => !isNaN(Number(val)) && Number(val) >= 0, {
    message: "Shares must be a non-negative number string",
  }),
  assetSymbol: z.string().min(1, "Asset symbol is required"),
  protocolName: z.string().min(1, "Protocol name is required"),
  network: z.nativeEnum(Network),
});

export const RebalanceEventSchema = z.object({
  protocol: z.string().min(1, "Protocol name is required"),
  apy: z.number().min(0, "APY must be a non-negative number"),
  timestamp: z.number().positive("Timestamp must be a positive number"),
  assetSymbol: z.string().min(1, "Asset symbol is required"),
  network: z.nativeEnum(Network),
});

export const ContractEventSchema = z.object({
  type: z.enum(['deposit', 'withdraw', 'rebalance']),
  ledger: z.number().int().nonnegative(),
  txHash: z.string().min(1),
  contractId: z.string().min(1),
});
