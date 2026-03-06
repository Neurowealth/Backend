import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import db from '../db';
import { Network } from '@prisma/client';

// simple stub encryption; in production plug in KMS (AWS/Google/etc)
function encryptSecret(secret: string): string {
  // for demo purposes we just base64 encode; this is NOT secure
  return Buffer.from(secret).toString('base64');
}

function decryptSecret(encrypted: string): string {
  return Buffer.from(encrypted, 'base64').toString('utf8');
}

function generateOtpCode(): string {
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  return code;
}

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

import { config } from '../config/env';

export interface WhatsAppUser {
  id: string;
  phoneNumber: string;
  walletAddress: string;
  walletSecretEncrypted?: string;
  otpCode?: string;
  otpExpiry?: Date;
  isActive: boolean;
  network: Network; // prisma Network enum
}

/**
 * Fetch a user by phone number; create a new record if none exists.
 * New users are created with isActive=false and an OTP code set.
 */
export async function getOrCreateUser(phoneNumber: string): Promise<WhatsAppUser> {
  let user = await db.user.findUnique({ where: { phoneNumber } });
  if (user) {
    return user as unknown as WhatsAppUser;
  }

  const pair = Keypair.random();
  const otp = generateOtpCode();
  const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

  const created = await db.user.create({
    data: {
      phoneNumber,
      walletAddress: pair.publicKey(),
      walletSecretEncrypted: encryptSecret(pair.secret()),
      otpCode: otp,
      otpExpiry: expiry,
      isActive: false,
      network: config.stellar.network.toUpperCase() as Network,
    },
  });

  return created as unknown as WhatsAppUser;
}

/**
 * Generate a fresh OTP for an existing user and update the record.
 * Returns the raw code so the caller can send it.
 */
export async function generateAndSaveOtp(phoneNumber: string): Promise<string> {
  const code = generateOtpCode();
  const expiry = new Date(Date.now() + OTP_EXPIRY_MS);
  await db.user.update({
    where: { phoneNumber },
    data: { otpCode: code, otpExpiry: expiry, isActive: false },
  });
  return code;
}

/**
 * Verify a code for the user and activate the account if valid.
 */
export async function verifyOtpCode(phoneNumber: string, code: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { phoneNumber } });
  if (!user || !user.otpCode || !user.otpExpiry) {
    return false;
  }

  if (user.otpExpiry < new Date()) {
    return false;
  }
  if (user.otpCode !== code.trim()) {
    return false;
  }

  await db.user.update({
    where: { phoneNumber },
    data: { isActive: true, otpCode: null, otpExpiry: null },
  });
  return true;
}

/**
 * Convenience helper to retrieve a user after we know it exists.
 */
export async function getUserByPhone(phoneNumber: string): Promise<WhatsAppUser | null> {
  const user = await db.user.findUnique({ where: { phoneNumber } });
  return user as unknown as WhatsAppUser | null;
}

/**
 * Helper to calculate approximate balance via positions (currentValue sum)
 */
export async function calculateBalance(phoneNumber: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { phoneNumber },
    include: { positions: true },
  });
  if (!user) return 0;
  const sum = user.positions.reduce((acc, pos) => acc + Number(pos.currentValue), 0);
  return sum;
}

export default {
  getOrCreateUser,
  generateAndSaveOtp,
  verifyOtpCode,
  getUserByPhone,
  calculateBalance,
};
