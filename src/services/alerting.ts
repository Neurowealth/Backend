/**
 * Alerting Service
 *
 * Pluggable alert dispatcher supporting multiple channels:
 * - LOG (always enabled, uses Winston logger)
 * - SLACK_WEBHOOK_URL (optional, posts to Slack)
 * - PAGERDUTY_ROUTING_KEY (optional, triggers PagerDuty incidents)
 *
 * Includes cooldown/deduplication to prevent alert fatigue.
 */

import { logger } from '../utils/logger'
import { dlqAlertActive } from '../utils/metrics'

export interface AlertPayload {
  title: string
  description: string
  severity: 'info' | 'warning' | 'critical'
  component: string
  metadata?: Record<string, unknown>
}

export interface DLQAlertPayload extends AlertPayload {
  dlqSize: number
  statusBreakdown: {
    pending: number
    retried: number
    resolved: number
  }
  oldestPendingAge?: {
    eventId: string
    ageMs: number
    ageHumanReadable: string
  }
  adminLink?: string
}

interface AlertState {
  lastAlertTime: number
  alertCount: number
}

/**
 * Alerting service with support for multiple channels and cooldown logic
 */
class AlertingService {
  private static instance: AlertingService
  private alertStates: Map<string, AlertState> = new Map()
  private cooldownMs: number = 15 * 60 * 1000 // 15 minutes default

  private slackWebhookUrl: string
  private pagerdutyRoutingKey: string
  private enabledChannels: Set<'LOG' | 'SLACK' | 'PAGERDUTY'>

  private constructor() {
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || ''
    this.pagerdutyRoutingKey = process.env.PAGERDUTY_ROUTING_KEY || ''
    this.enabledChannels = new Set()
    this.enabledChannels.add('LOG') // Always enabled

    if (this.slackWebhookUrl) {
      this.enabledChannels.add('SLACK')
    }
    if (this.pagerdutyRoutingKey) {
      this.enabledChannels.add('PAGERDUTY')
    }
  }

  static getInstance(): AlertingService {
    if (!AlertingService.instance) {
      AlertingService.instance = new AlertingService()
    }
    return AlertingService.instance
  }

  /**
   * Check if alert is within cooldown window (deduplication)
   */
  private isWithinCooldown(alertKey: string): boolean {
    const state = this.alertStates.get(alertKey)
    if (!state) return false

    const timeSinceLastAlert = Date.now() - state.lastAlertTime
    return timeSinceLastAlert < this.cooldownMs
  }

  /**
   * Update alert state for cooldown tracking
   */
  private updateAlertState(alertKey: string): void {
    const state = this.alertStates.get(alertKey) || {
      lastAlertTime: 0,
      alertCount: 0,
    }
    state.lastAlertTime = Date.now()
    state.alertCount++
    this.alertStates.set(alertKey, state)
  }

  /**
   * Get cooldown status (useful for monitoring)
   */
  private getCooldownRemaining(alertKey: string): number {
    const state = this.alertStates.get(alertKey)
    if (!state) return 0

    const timeSinceLastAlert = Date.now() - state.lastAlertTime
    const remaining = this.cooldownMs - timeSinceLastAlert
    return Math.max(0, remaining)
  }

  /**
   * Emit alert to all enabled channels with cooldown checking
   */
  async emit(
    payload: AlertPayload,
    alertKey?: string
  ): Promise<{ sent: boolean; reason?: string }> {
    const key = alertKey || `${payload.component}:${payload.severity}`

    // Check cooldown
    if (this.isWithinCooldown(key)) {
      const remaining = this.getCooldownRemaining(key)
      return {
        sent: false,
        reason: `Alert suppressed by cooldown. Next alert in ${Math.round(remaining / 1000)}s`,
      }
    }

    try {
      const promises: Promise<void>[] = []

      if (this.enabledChannels.has('LOG')) {
        promises.push(this.sendToLog(payload))
      }

      if (this.enabledChannels.has('SLACK')) {
        promises.push(
          this.sendToSlack(payload).catch((err) => {
            logger.error('[Alerting] Failed to send Slack alert:', err)
          })
        )
      }

      if (this.enabledChannels.has('PAGERDUTY')) {
        promises.push(
          this.sendToPagerDuty(payload).catch((err) => {
            logger.error('[Alerting] Failed to send PagerDuty alert:', err)
          })
        )
      }

      await Promise.all(promises)
      this.updateAlertState(key)
      return { sent: true }
    } catch (error) {
      logger.error('[Alerting] Error emitting alert:', error)
      return {
        sent: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Emit DLQ-specific alert with rich metadata
   */
  async emitDLQAlert(
    payload: DLQAlertPayload
  ): Promise<{ sent: boolean; reason?: string }> {
    const result = await this.emit(payload, 'dlq:threshold')

    // Update Prometheus gauge
    if (payload.severity === 'critical') {
      dlqAlertActive.set(1)
    } else {
      dlqAlertActive.set(0)
    }

    return result
  }

  /**
   * Clear DLQ alert state (when queue drops below threshold)
   */
  clearDLQAlertState(): void {
    this.alertStates.delete('dlq:threshold')
    dlqAlertActive.set(0)
    logger.info('[Alerting] DLQ alert state cleared (queue normalized)')
  }

  /**
   * Send alert to Winston logger
   */
  private async sendToLog(payload: AlertPayload): Promise<void> {
    const logLevel =
      payload.severity === 'critical'
        ? 'error'
        : payload.severity === 'warning'
          ? 'warn'
          : 'info'
    const message = `[ALERT] [${payload.component.toUpperCase()}] ${payload.title}: ${payload.description}`

    if (logLevel === 'error') {
      logger.error(message, payload.metadata)
    } else if (logLevel === 'warn') {
      logger.warn(message, payload.metadata)
    } else {
      logger.info(message, payload.metadata)
    }
  }

  /**
   * Send alert to Slack
   */
  private async sendToSlack(
    payload: AlertPayload | DLQAlertPayload
  ): Promise<void> {
    if (!this.slackWebhookUrl) {
      return
    }

    const color =
      payload.severity === 'critical'
        ? 'danger'
        : payload.severity === 'warning'
          ? 'warning'
          : 'good'
    const dlqPayload = payload as DLQAlertPayload

    const blocks: Array<Record<string, unknown>> = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚨 ${payload.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: payload.description,
        },
      },
    ]

    // Add DLQ-specific metadata
    if (dlqPayload.dlqSize !== undefined) {
      const fields: Array<Record<string, string>> = [
        {
          type: 'mrkdwn',
          text: `*Current Size:*\n${dlqPayload.dlqSize} events`,
        },
        {
          type: 'mrkdwn',
          text: `*Severity:*\n${payload.severity.toUpperCase()}`,
        },
      ]

      if (dlqPayload.statusBreakdown) {
        fields.push({
          type: 'mrkdwn',
          text: `*Status Breakdown:*\nPending: ${dlqPayload.statusBreakdown.pending}\nRetried: ${dlqPayload.statusBreakdown.retried}\nResolved: ${dlqPayload.statusBreakdown.resolved}`,
        })
      }

      if (dlqPayload.oldestPendingAge) {
        fields.push({
          type: 'mrkdwn',
          text: `*Oldest Event:*\nAge: ${dlqPayload.oldestPendingAge.ageHumanReadable}\nID: \`${dlqPayload.oldestPendingAge.eventId}\``,
        })
      }

      blocks.push({
        type: 'section',
        fields,
      })
    }

    // Add custom metadata if present
    if (payload.metadata && Object.keys(payload.metadata).length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Additional Info:*\n${Object.entries(payload.metadata)
            .map(([key, value]) => `• ${key}: ${JSON.stringify(value)}`)
            .join('\n')}`,
        },
      })
    }

    // Add action links
    if (dlqPayload.adminLink) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Inspect DLQ',
              emoji: true,
            },
            url: dlqPayload.adminLink,
            style: 'danger',
          },
        ],
      })
    }

    const response = await fetch(this.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks,
        attachments: [
          {
            color,
            footer: 'NeuroWealth DLQ Alert System',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(
        `Slack webhook returned ${response.status}: ${response.statusText}`
      )
    }
  }

  /**
   * Send alert to PagerDuty
   */
  private async sendToPagerDuty(
    payload: AlertPayload | DLQAlertPayload
  ): Promise<void> {
    if (!this.pagerdutyRoutingKey) {
      return
    }

    const dlqPayload = payload as DLQAlertPayload
    const severity =
      payload.severity === 'critical'
        ? 'critical'
        : payload.severity === 'warning'
          ? 'warning'
          : 'info'

    let customDetails: Record<string, unknown> = {
      ...payload.metadata,
    }

    if (dlqPayload.dlqSize !== undefined) {
      customDetails = {
        ...customDetails,
        dlq_size: dlqPayload.dlqSize,
        status_breakdown: dlqPayload.statusBreakdown,
        oldest_event_age: dlqPayload.oldestPendingAge?.ageHumanReadable,
      }
    }

    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key: this.pagerdutyRoutingKey,
        event_action: 'trigger',
        dedup_key: `dlq-alert-${Math.floor(Date.now() / 60000)}`, // Group by minute
        payload: {
          summary: payload.title,
          severity,
          source: 'NeuroWealth Backend',
          component: payload.component,
          custom_details: customDetails,
        },
        client: 'NeuroWealth DLQ Alerting',
        client_url: dlqPayload.adminLink,
      }),
    })

    if (!response.ok) {
      throw new Error(
        `PagerDuty API returned ${response.status}: ${response.statusText}`
      )
    }
  }

  /**
   * Check enabled channels (for diagnostics)
   */
  getEnabledChannels(): string[] {
    return Array.from(this.enabledChannels)
  }
}

export const alertingService = AlertingService.getInstance()
