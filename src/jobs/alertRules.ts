import db from '../db';
import { logger, logBackgroundJob } from '../utils/logger';
import {
  generateCorrelationId,
  runWithCorrelationIdAsync,
} from '../utils/correlation';
import { recordJobSuccess, recordJobFailure } from '../utils/job-metrics';
import { config } from '../config/env';
import { dispatchWebhookEvent } from '../services/webhookDispatcher';
import { sendWhatsAppMessage } from '../utils/twilio-client';
import { formatAlertTriggeredReply } from '../whatsapp/formatters';
import {
  compare,
  cooldownCutoff,
  computeDrawdownPercent,
  rollingPeak,
  type AlertMetric,
  type Comparator,
} from '../services/alertEvaluator';

/**
 * Custom price & yield alert rule evaluator (#289).
 *
 * On each tick this job loads ACTIVE rules, computes the current value for each
 * rule's metric, and fires a notification when the comparator condition holds
 * and the rule is outside its cooldown window. Fires go out over the webhook
 * (HMAC-signed, via the existing dispatchWebhookEvent) and/or WhatsApp channels.
 *
 * Design decisions (see issue #289):
 *
 *  • Cooldown: a rule sitting at its threshold notifies at most once per
 *    cooldownMinutes. The condition does NOT need to flip false→true again — it
 *    re-fires once the cooldown elapses if still true.
 *
 *  • Fire-claim is atomic: before delivering, we updateMany the row with a
 *    guard on { id, isActive, lastFiredAt within-cooldown }. If the rule was
 *    deleted or deactivated earlier in the same tick (or already fired by a
 *    concurrent runner), the update matches 0 rows and we skip delivery — no
 *    error, no double-send. This covers the "user deletes a rule mid-tick" and
 *    "condition true across many ticks" edge cases.
 *
 *  • PROTOCOL_APY drawdown reference: see computeDrawdownPercent. Drawdown is
 *    measured against the rolling 30-day peak portfolio value (documented in
 *    docs/ALERTS.md).
 *
 *  • Delisted protocol: a PROTOCOL_APY rule whose protocol has no ProtocolRate
 *    row is auto-deactivated (isActive=false) with a clear log line rather than
 *    evaluated against stale/missing data.
 *
 *  • Failed webhook delivery: we reuse dispatchWebhookEvent as-is. Its internal
 *    3-attempt backoff is the only retry; there is no separate sweep for alert
 *    deliveries. Rationale documented in docs/ALERTS.md — the next tick re-
 *    evaluates the live condition, so a transient delivery failure self-heals
 *    on the following tick (bounded by cooldown) rather than replaying a stale
 *    alert. We do NOT advance lastFiredAt when the condition is still fresh and
 *    delivery hard-fails on all channels, so the alert is retried next tick.
 */

const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface AlertRuleRow {
  id: string;
  userId: string;
  metric: AlertMetric;
  protocolName: string | null;
  comparator: Comparator;
  threshold: unknown; // Prisma Decimal
  deliveryChannel: 'WEBHOOK' | 'WHATSAPP' | 'BOTH';
  cooldownMinutes: number;
  lastFiredAt: Date | null;
}

const ASSET_SYMBOL = 'USDC';

/**
 * Resolve the observed value for a rule's metric, or null when it cannot be
 * evaluated this tick (missing data). Returns `delisted: true` for a
 * PROTOCOL_APY rule whose protocol has no rate data so the caller can
 * auto-deactivate it.
 */
async function observeMetric(
  rule: AlertRuleRow,
  now: Date,
): Promise<{ value: number | null; delisted?: boolean }> {
  switch (rule.metric) {
    case 'PROTOCOL_APY': {
      if (!rule.protocolName) return { value: null };
      const latestRate = await db.protocolRate.findFirst({
        where: { protocolName: rule.protocolName, assetSymbol: ASSET_SYMBOL },
        orderBy: { fetchedAt: 'desc' },
        select: { supplyApy: true },
      });
      if (!latestRate) {
        // Protocol delisted/removed — no rate data to evaluate against.
        return { value: null, delisted: true };
      }
      // supplyApy is stored as a fraction (0.0842 == 8.42%); thresholds are
      // expressed in percent, so scale to percent for comparison.
      return { value: Number(latestRate.supplyApy) * 100 };
    }

    case 'PORTFOLIO_VALUE': {
      const positions = await db.position.findMany({
        where: { userId: rule.userId, status: 'ACTIVE' },
        select: { currentValue: true },
      });
      const total = positions.reduce(
        (sum, p) => sum + Number(p.currentValue),
        0,
      );
      return { value: total };
    }

    case 'POSITION_DRAWDOWN': {
      // Drawdown of the user's total portfolio value from its rolling 30-day
      // peak. The peak is the max of historical YieldSnapshot principal+yield
      // samples and the current value (see docs/ALERTS.md for the exact window).
      const positions = await db.position.findMany({
        where: { userId: rule.userId, status: 'ACTIVE' },
        select: { id: true, currentValue: true },
      });
      if (positions.length === 0) return { value: 0 };

      const currentValue = positions.reduce(
        (sum, p) => sum + Number(p.currentValue),
        0,
      );

      const fromDate = new Date(now.getTime() - WINDOW_MS);
      const snapshots = await db.yieldSnapshot.findMany({
        where: {
          positionId: { in: positions.map((p) => p.id) },
          snapshotAt: { gte: fromDate },
        },
        select: { principalAmount: true, yieldAmount: true, snapshotAt: true },
      });

      // Aggregate snapshots into per-instant portfolio values so the peak is a
      // whole-portfolio high, not a single position's.
      const valueByInstant = new Map<number, number>();
      for (const s of snapshots) {
        const key = s.snapshotAt.getTime();
        const v = Number(s.principalAmount) + Number(s.yieldAmount);
        valueByInstant.set(key, (valueByInstant.get(key) ?? 0) + v);
      }
      const peak = rollingPeak(
        Array.from(valueByInstant.values()),
        currentValue,
      );
      return { value: computeDrawdownPercent(peak, currentValue) };
    }

    default:
      return { value: null };
  }
}

/**
 * Atomically claim a fire for a rule: set lastFiredAt=now only if the rule is
 * still active and still outside its cooldown. Returns true if this call won
 * the claim (and should therefore deliver). Guards against delete/deactivate
 * mid-tick and concurrent runners.
 */
async function claimFire(rule: AlertRuleRow, now: Date): Promise<boolean> {
  const cutoff = cooldownCutoff(rule.cooldownMinutes, now);
  const result = await db.alertRule.updateMany({
    where: {
      id: rule.id,
      isActive: true,
      OR: [{ lastFiredAt: null }, { lastFiredAt: { lte: cutoff } }],
    },
    data: { lastFiredAt: now },
  });
  return result.count === 1;
}

/**
 * Deliver a triggered alert over the rule's channel(s). Returns true if at
 * least one channel delivered (or was attempted without a hard local failure).
 */
async function deliverAlert(
  rule: AlertRuleRow,
  observedValue: number,
): Promise<void> {
  const threshold = Number(rule.threshold);
  const data = {
    ruleId: rule.id,
    userId: rule.userId,
    metric: rule.metric,
    protocolName: rule.protocolName,
    comparator: rule.comparator,
    threshold,
    observedValue,
    triggeredAt: new Date().toISOString(),
  };

  const wantsWebhook =
    rule.deliveryChannel === 'WEBHOOK' || rule.deliveryChannel === 'BOTH';
  const wantsWhatsApp =
    rule.deliveryChannel === 'WHATSAPP' || rule.deliveryChannel === 'BOTH';

  if (wantsWebhook) {
    // HMAC-signed via the existing dispatcher; no new unsigned path.
    await dispatchWebhookEvent('alert_rule.triggered', data);
  }

  if (wantsWhatsApp) {
    const user = await db.user.findUnique({
      where: { id: rule.userId },
      select: { phone: true },
    });
    if (!user?.phone) {
      logger.warn(
        `[AlertRules] Rule ${rule.id} requests WhatsApp delivery but user ${rule.userId} has no phone on file — skipping WhatsApp channel`,
      );
    } else {
      const body = formatAlertTriggeredReply({
        metric: rule.metric,
        protocolName: rule.protocolName,
        comparator: rule.comparator,
        threshold,
        observedValue,
      });
      await sendWhatsAppMessage({ to: `whatsapp:${user.phone}`, body });
    }
  }
}

export async function runAlertRules(now: Date = new Date()): Promise<void> {
  const correlationId = generateCorrelationId();
  return runWithCorrelationIdAsync(correlationId, async () => {
    const start = Date.now();
    const jobName = 'alert_rules';

    let evaluated = 0;
    let fired = 0;
    let deactivated = 0;

    try {
      const rules = (await db.alertRule.findMany({
        where: { isActive: true },
        select: {
          id: true,
          userId: true,
          metric: true,
          protocolName: true,
          comparator: true,
          threshold: true,
          deliveryChannel: true,
          cooldownMinutes: true,
          lastFiredAt: true,
        },
      })) as AlertRuleRow[];

      for (const rule of rules) {
        evaluated++;
        try {
          const { value, delisted } = await observeMetric(rule, now);

          if (delisted) {
            await db.alertRule.updateMany({
              where: { id: rule.id },
              data: { isActive: false },
            });
            deactivated++;
            logger.warn(
              `[AlertRules] Deactivated rule ${rule.id}: protocol "${rule.protocolName}" has no rate data (delisted/removed)`,
            );
            continue;
          }

          if (value === null) continue;

          const conditionMet = compare(
            rule.comparator,
            value,
            Number(rule.threshold),
          );
          if (!conditionMet) continue;

          // Atomically claim the fire (cooldown + delete/deactivate guard).
          const won = await claimFire(rule, now);
          if (!won) continue;

          try {
            await deliverAlert(rule, value);
            fired++;
          } catch (deliveryError) {
            // Delivery failed after the claim advanced lastFiredAt. Roll the
            // claim back so the alert is retried on the next tick if the
            // condition is still true, rather than being silently swallowed for
            // a full cooldown window.
            await db.alertRule
              .updateMany({
                where: { id: rule.id },
                data: { lastFiredAt: rule.lastFiredAt },
              })
              .catch(() => undefined);
            logger.error(
              `[AlertRules] Delivery failed for rule ${rule.id}; fire-claim rolled back for retry`,
              {
                error:
                  deliveryError instanceof Error
                    ? deliveryError.message
                    : String(deliveryError),
              },
            );
          }
        } catch (ruleError) {
          // One bad rule must not abort the sweep.
          logger.error(`[AlertRules] Error evaluating rule ${rule.id}`, {
            error:
              ruleError instanceof Error
                ? ruleError.message
                : String(ruleError),
          });
        }
      }

      const durationMs = Date.now() - start;
      logBackgroundJob(jobName, 'success', durationMs / 1000, correlationId, {
        evaluated,
        fired,
        deactivated,
      });
      recordJobSuccess(jobName, durationMs);
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logBackgroundJob(jobName, 'failed', durationMs / 1000, correlationId, {
        error: errorMessage,
      });
      recordJobFailure(jobName, durationMs);
    }
  });
}

/**
 * Schedule the alert-rule evaluator. Runs once on startup then on the
 * configured interval, following the same pattern as the other jobs.
 *
 * @returns NodeJS.Timeout handle — pass to clearInterval() on shutdown.
 */
export function scheduleAlertRules(): NodeJS.Timeout {
  void runAlertRules();

  const intervalMs = config.alertRules.intervalMs;
  const handle = setInterval(() => {
    void runAlertRules();
  }, intervalMs);

  handle.unref?.();

  logger.info(
    `[AlertRules] Alert-rule evaluation scheduled every ${intervalMs}ms`,
  );
  return handle;
}
