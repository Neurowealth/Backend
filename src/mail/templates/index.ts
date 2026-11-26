import { MailMessage } from '../mailProvider'

export function renderEmailVerification(
  to: string,
  verifyUrl: string
): MailMessage {
  const subject = 'Verify your email address - NeuroWealth'
  const html = `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>Welcome to NeuroWealth</h2>
      <p>Please click the button below to verify your email address and enable email notifications:</p>
      <p><a href="${verifyUrl}" style="background: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
      <p>Or copy this link: ${verifyUrl}</p>
      <hr />
      <p style="font-size: 12px; color: #666;">NeuroWealth Notifications | <a href="https://neurowealth.app/preferences">Manage Preferences</a></p>
    </div>
  `
  const text = `
Welcome to NeuroWealth!

Please verify your email address to enable email notifications by opening the link below:
${verifyUrl}

--
NeuroWealth Notifications
Manage Preferences: https://neurowealth.app/preferences
  `.trim()

  return { to, subject, html, text }
}

export function renderAlertEmail(
  to: string,
  data: {
    metric: string
    comparator: string
    threshold: number
    observedValue: number
    protocolName?: string | null
    ackToken?: string
  }
): MailMessage {
  const subject = `[ALERT] ${data.metric} triggered on NeuroWealth`
  const html = `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2 style="color: #cc0000;">Alert Rule Triggered</h2>
      <p><strong>Metric:</strong> ${data.metric}</p>
      ${data.protocolName ? `<p><strong>Protocol:</strong> ${data.protocolName}</p>` : ''}
      <p><strong>Observed Value:</strong> ${data.observedValue}</p>
      <p><strong>Condition:</strong> ${data.comparator} ${data.threshold}</p>
      <hr />
      <p style="font-size: 12px; color: #666;"><a href="https://neurowealth.app/alerts">View Alerts</a> | <a href="https://neurowealth.app/preferences">Manage Preferences</a></p>
    </div>
  `
  const text = `
ALERT TRIGGERED

Metric: ${data.metric}
${data.protocolName ? `Protocol: ${data.protocolName}\n` : ''}Observed Value: ${data.observedValue}
Condition: ${data.comparator} ${data.threshold}

--
View Alerts: https://neurowealth.app/alerts
Manage Preferences: https://neurowealth.app/preferences
  `.trim()

  return { to, subject, html, text }
}

export function renderAccountRecoveryAlert(
  to: string,
  data: {
    event: string
    requestId?: string
    ownerWalletAddress?: string
    newWalletAddress?: string
    completesAt?: string | null
    cancelToken?: string
  }
): MailMessage {
  const subject = 'Account recovery security alert - NeuroWealth'
  const details = [
    `Event: ${data.event}`,
    data.requestId ? `Request: ${data.requestId}` : null,
    data.ownerWalletAddress
      ? `Current wallet: ${data.ownerWalletAddress}`
      : null,
    data.newWalletAddress
      ? `Requested new wallet: ${data.newWalletAddress}`
      : null,
    data.completesAt ? `Scheduled completion: ${data.completesAt}` : null,
    data.cancelToken
      ? `Cancellation token (submit to POST /api/v1/recovery/${data.requestId}/cancel-email): ${data.cancelToken}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  const instructions = data.cancelToken
    ? 'If you did not initiate this request, cancel it using the one-time token above or an active session.'
    : 'Account owners can cancel through an active session. Guardians should not approve an unrecognized request and should contact the account owner.'
  const text = `A security-sensitive account recovery event occurred.\n\n${details}\n\n${instructions}`
  const html = `<div style="font-family:sans-serif;padding:20px"><h2>Account recovery security alert</h2><p>A security-sensitive account recovery event occurred.</p><pre>${details}</pre><p>${instructions}</p></div>`
  return { to, subject, html, text }
}
