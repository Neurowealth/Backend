import type { Intent } from '../nlp/parser';

/**
 * Pending voice-originated confirmations (#288).
 *
 * A financial intent (deposit/withdraw/strategy change) recognized from a voice
 * note is NOT executed immediately — it is parked here and echoed back to the
 * user ("I heard: withdraw $50 — confirm?"). The user's next message (voice or
 * text) is checked for an affirmative/negative reply before the intent runs.
 *
 * In-memory and keyed by normalized phone, matching the existing WhatsApp user
 * store. A pending confirmation expires after a short TTL so a stale "yes" long
 * after the fact can never trigger a fund movement.
 */

export interface PendingConfirmation {
  intent: Intent;
  /** Human-readable echo shown to the user, kept for logging/debugging. */
  summary: string;
  expiresAt: number;
}

const store = new Map<string, PendingConfirmation>();

/** How long a parked confirmation stays valid. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function setPendingConfirmation(
  phone: string,
  intent: Intent,
  summary: string,
  now: number = Date.now(),
): void {
  store.set(phone, { intent, summary, expiresAt: now + CONFIRMATION_TTL_MS });
}

/**
 * Return the live pending confirmation for a phone, or null if none exists or
 * it has expired. Expired entries are evicted on read.
 */
export function getPendingConfirmation(
  phone: string,
  now: number = Date.now(),
): PendingConfirmation | null {
  const pending = store.get(phone);
  if (!pending) return null;
  if (now >= pending.expiresAt) {
    store.delete(phone);
    return null;
  }
  return pending;
}

export function clearPendingConfirmation(phone: string): void {
  store.delete(phone);
}

/** Test seam. */
export function clearAllPendingConfirmations(): void {
  store.clear();
}
