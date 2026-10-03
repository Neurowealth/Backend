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

// ─── #535 Guardian-based social recovery ─────────────────────────────────────

function recoveryActionBlock(
  heading: string,
  intro: string,
  actionLabel: string,
  actionUrl: string,
  footer: string
): string {
  return `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2 style="color: #cc0000;">${heading}</h2>
      <p>${intro}</p>
      <p><a href="${actionUrl}" style="background: #cc0000; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">${actionLabel}</a></p>
      <p>Or copy this link:<br />${actionUrl}</p>
      <hr />
      <p style="font-size: 12px; color: #666;">${footer}</p>
    </div>
  `
}

/**
 * Sent to the ACCOUNT OWNER's registered email the moment a recovery request is
 * opened against it. This is the load-bearing alert of the whole feature: the
 * claimant may have social-engineered every guardian, but the owner still
 * receives this, and the request stays cancellable until the delay expires.
 */
export function renderRecoveryInitiatedAlert(
  to: string,
  data: {
    reason: string
    requiredApprovals: number
    acceptedGuardians: number
    initiateAt: string
  }
): MailMessage {
  const cancelUrl = `${
    process.env.APP_URL || 'https://neurowealth.app'
  }/account/recovery`
  const intro = `A request to recover access to your account was submitted at <strong>${data.initiateAt}</strong>. If you did not make this request, cancel it — cancellation is immediate and does not require your guardians to agree.`
  const footer =
    'If you did not make this request, someone may be attempting to take over your account. Do not share any codes or approve anything on their behalf. NeuroWealth will never ask you to disable these alerts.'

  return {
    to,
    subject:
      '[SECURITY] Account recovery requested - act now if this was not you',
    html: recoveryActionBlock(
      'Account recovery requested',
      intro,
      'Review and cancel',
      cancelUrl,
      footer
    ),
    text: `
ACCOUNT RECOVERY REQUESTED

A request to recover access to your account was submitted at ${data.initiateAt}.

Stated reason: ${data.reason}
Approvals needed: ${data.requiredApprovals} of ${data.acceptedGuardians} accepted guardians

If you did NOT make this request, cancel it now. Cancellation is immediate and
does not require your guardians to agree.

Review and cancel: ${cancelUrl}

If you did not make this request, someone may be attempting to take over your
account. Do not share any codes or approve anything on their behalf.
NeuroWealth will never ask you to disable these alerts.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}

/**
 * Sent to every accepted guardian when a recovery is opened against someone they
 * are a guardian for. Carries the individual decision link, so approving is an
 * explicit per-guardian action that cannot be batched.
 */
export function renderGuardianApprovalRequest(
  to: string,
  data: {
    requestId: string
    approveUrl: string
    executeAfter: string | null
    /** Masked wallet hint, so the guardian can tell WHICH account this is. */
    accountHint?: string
    /** The claimant's stated reason. Attacker-controlled free text. */
    reason?: string
    requiredApprovals?: number
    expiresAt?: string
  }
): MailMessage {
  // The stated reason is the single most useful thing a guardian has, but it is
  // attacker-controlled. Escape it: this string is rendered into HTML.
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const who = data.accountHint ?? 'Somebody'
  const reasonLine = data.reason
    ? `They gave this reason: <em>${escape(data.reason)}</em>`
    : ''

  const intro = `${who} has asked to recover access to an account you are a guardian for. ${reasonLine} Nothing has happened yet: a recovery cannot complete until it has your explicit approval AND the mandatory waiting period passes. Approving only confirms you recognise them as the account owner — it does not give you access to the account, and we will never ask you for a password, code, or payment.`
  const footer =
    "Only approve if you personally know this person, are expecting this, and have spoken to them through a channel you already trust. If you are unsure, decline — a declined approval is always safer than a mistaken one. Guardians are chosen precisely because a stranger's say-so is not enough."

  return {
    to,
    subject:
      '[ACTION NEEDED] You are a guardian for an account recovery request',
    html: recoveryActionBlock(
      'Guardian approval needed',
      intro,
      'Review this request',
      data.approveUrl,
      footer
    ),
    text: `
GUARDIAN APPROVAL NEEDED

${who} has asked to recover access to an account you are a guardian for.
${data.reason ? `Stated reason: ${data.reason}` : ''}
Nothing has happened yet: a recovery cannot complete until it has your explicit
approval AND the mandatory waiting period passes.

Approving only confirms that you recognise them as the account owner. It does
NOT give you access to the account. We will never ask you for a password, a
code, or a payment in order to approve.

Request: ${data.requestId}
Earliest completion: ${
      data.executeAfter ?? 'after the waiting period once quorum is reached'
    }
${data.expiresAt ? `This request expires ${data.expiresAt}.` : ''}

Review this request: ${data.approveUrl}

Only approve if you personally know this person, are expecting this, and have
spoken to them through a channel you already trust. If you are unsure, decline.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}

/**
 * Sent to the owner when quorum is reached, so the cooling-off window is not a
 * surprise: this is the moment the request becomes real, and the last moment it
 * can be stopped without guardian involvement.
 */
export function renderRecoveryQuorumReachedAlert(
  to: string,
  data: { requiredApprovals: number; executeAfter: string }
): MailMessage {
  const cancelUrl = `${
    process.env.APP_URL || 'https://neurowealth.app'
  }/account/recovery`

  return {
    to,
    subject:
      '[SECURITY] Recovery approved - you can still cancel until the deadline',
    html: recoveryActionBlock(
      'Your recovery request has enough approvals',
      `Your guardians have approved this request (${data.requiredApprovals} approvals). It will take effect at <strong>${data.executeAfter}</strong>, and every existing session will be revoked when it does. Until then you can cancel it yourself, immediately, with no guardian consensus required.`,
      'Cancel recovery',
      cancelUrl,
      'If you did not request this, cancel now and change the email address on your account — somebody may have reached your guardians.'
    ),
    text: `
RECOVERY APPROVED - STILL CANCELLABLE

Your guardians approved this request (${data.requiredApprovals} approvals).

It takes effect at: ${data.executeAfter}
Every existing session will be revoked when it does.

You can still cancel it yourself, immediately, with no guardian consensus
required.

Cancel recovery: ${cancelUrl}

If you did not request this, cancel now and change the email address on your
account - somebody may have reached your guardians.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}

/**
 * Sent to the owner after a recovery completes. The sessions are already gone by
 * the time this is sent, so this doubles as the confirmation and as the warning
 * that the account's access history has just changed.
 */
export function renderRecoveryCompletedAlert(
  to: string,
  data: { revokedSessions: number; executedAt: string }
): MailMessage {
  return {
    to,
    subject: '[SECURITY] Account recovery completed - all sessions revoked',
    html: recoveryActionBlock(
      'Account recovery completed',
      `Access to your account was reset at <strong>${data.executedAt}</strong> and ${data.revokedSessions} existing session(s) were revoked, so you will need to sign in again everywhere.`,
      'Sign in',
      `${process.env.APP_URL || 'https://neurowealth.app'}/login`,
      'If you did not authorise this, your account has been recovered by someone else. Rotate your guardian set immediately and contact support.'
    ),
    text: `
ACCOUNT RECOVERY COMPLETED

Access to your account was reset at ${data.executedAt}.
${data.revokedSessions} existing session(s) were revoked - you will need to sign
in again everywhere.

If you did not authorise this, your account has been recovered by someone else.
Rotate your guardian set immediately and contact support.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}

/** Sent to the owner the moment THEY cancel, confirming the attempt is closed. */
export function renderRecoveryCancelledNotice(
  to: string,
  data: { cancelledAt: string }
): MailMessage {
  return {
    to,
    subject: 'Account recovery cancelled',
    html: recoveryActionBlock(
      'Recovery cancelled',
      `You cancelled the recovery request for your account at <strong>${data.cancelledAt}</strong>. It will not proceed and no further approvals will be sought.`,
      'Manage guardians',
      `${process.env.APP_URL || 'https://neurowealth.app'}/account/guardians`,
      'If this was not you, review your guardian list — removing a guardian takes effect immediately.'
    ),
    text: `
RECOVERY CANCELLED

You cancelled the recovery request for your account at ${data.cancelledAt}.
It will not proceed and no further approvals will be sought.

If this was not you, review your guardian list - removing a guardian takes
effect immediately.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}

/**
 * Guardian nomination invite. Carries no recovery authority at all — accepting
 * only enrolls the recipient as a co-signer. Saying so explicitly is the point:
 * an external contact receiving this should understand they are being asked to
 * stand ready, not to grant anything now.
 */
export function renderGuardianInvite(
  to: string,
  data: { accountHint: string; acceptUrl: string; expiresAt: string }
): MailMessage {
  return {
    to,
    subject:
      'You have been nominated as a recovery guardian for a NeuroWealth account',
    html: `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>Recovery guardian nomination</h2>
      <p>${data.accountHint} has nominated you as a recovery guardian for their NeuroWealth account.</p>
      <p><strong>What accepting means:</strong> if they ever lose access to their account, we may contact you to ask whether you can confirm their identity. <strong>You are not being asked for any credential, code, or money, and accepting does not give you any access to the account.</strong></p>
      <p>Declining is fine and has no effect on the account. You can ask to be removed at any time.</p>
      <p><a href="${data.acceptUrl}" style="background: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Accept or decline</a></p>
      <p>Or copy this link: ${data.acceptUrl}</p>
      <p style="font-size: 12px; color: #666;">This invitation expires ${data.expiresAt}.</p>
    </div>
  `,
    text: `
RECOVERY GUARDIAN NOMINATION

${data.accountHint} has nominated you as a recovery guardian for their
NeuroWealth account.

What accepting means: if they ever lose access to their account, we may contact
you to ask whether you can confirm their identity. You are NOT being asked for
any credential, code, or money, and accepting does not give you any access to
the account.

Declining is fine and has no effect on the account. You can ask to be removed at
any time.

Accept or decline: ${data.acceptUrl}

This invitation expires ${data.expiresAt}.
    `
      .trim()
      .replace(/^ {4}/gm, ''),
  }
}
