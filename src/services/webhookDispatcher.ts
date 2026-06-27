import db from '../db';
import { logger } from '../utils/logger';
import { signPayload } from '../utils/webhookSignature';
import type { WebhookEvent } from '../validators/webhook-validators';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatch a webhook event to all active subscriptions that listen for it.
 * Persists a WebhookDelivery record and retries up to MAX_ATTEMPTS times
 * with exponential back-off.
 */
export async function dispatchWebhookEvent(
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const subscriptions = await (db as any).webhookSubscription.findMany({
    where: {
      isActive: true,
      events: { has: event },
    },
  });

  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });

  await Promise.allSettled(
    subscriptions.map((sub: any) => deliverToSubscription(sub, event, payload)),
  );
}

async function deliverToSubscription(
  sub: { id: string; url: string; secret: string },
  event: string,
  payload: string,
): Promise<void> {
  const signature = signPayload(sub.secret, payload);

  const delivery = await (db as any).webhookDelivery.create({
    data: {
      subscriptionId: sub.id,
      event,
      payload: JSON.parse(payload),
      status: 'PENDING',
    },
  });

  let lastError = '';
  let statusCode: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Neurowealth-Signature': signature,
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      statusCode = res.status;

      if (res.ok) {
        await (db as any).webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SUCCESS', statusCode, attempts: attempt, error: null },
        });
        return;
      }

      lastError = `HTTP ${res.status}: ${res.statusText}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    logger.warn(`[Webhook] Delivery attempt ${attempt}/${MAX_ATTEMPTS} failed for ${sub.url}: ${lastError}`);

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1)); // 1s, 2s, 4s
    }
  }

  await (db as any).webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'FAILED',
      statusCode: statusCode ?? null,
      attempts: MAX_ATTEMPTS,
      error: lastError,
    },
  });

  logger.error(`[Webhook] All ${MAX_ATTEMPTS} delivery attempts failed for subscription ${sub.id}`, {
    url: sub.url,
    error: lastError,
  });
}
