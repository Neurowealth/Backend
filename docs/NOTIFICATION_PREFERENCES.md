# Notification Preference Management

## Overview

This document describes the notification preference management system for Telegram, WhatsApp, Email, and SMS channels. The system ensures user trust and compliance, reduces noisy communication, and supports preference changes without service disruption.

## Preference Model

### Data Structure

```typescript
type NotificationPreference = {
  userId: string
  channel: 'telegram' | 'whatsapp' | 'email' | 'sms'
  category: 'portfolio_updates' | 'rebalance_alerts' | 'yield_claims' | 'risk_alerts' | 'system_updates' | 'marketing'
  enabled: boolean
  quietHours?: {
    enabled: boolean
    startHour: number // 0-23
    endHour: number // 0-23
    timezone: string // IANA timezone
  }
  frequency?: 'immediate' | 'daily' | 'weekly'
  updatedAt: Date
  updatedBy: 'user' | 'admin' | 'system'
}
```

### Categories

| Category | Description | Default |
|----------|-------------|---------|
| `portfolio_updates` | Portfolio value changes, position updates | Enabled |
| `rebalance_alerts` | Agent-initiated rebalance notifications | Enabled |
| `yield_claims` | Yield claim opportunities and confirmations | Enabled |
| `risk_alerts` | Protocol risk warnings, de-peg alerts | Enabled |
| `system_updates` | Platform maintenance, feature updates | Enabled |
| `marketing` | Promotional content, referrals | Disabled |

### Channels

| Channel | Description | Opt-in Required |
|---------|-------------|-----------------|
| `telegram` | Telegram bot notifications | Yes |
| `whatsapp` | WhatsApp bot notifications | Yes |
| `email` | Email notifications | Yes |
| `sms` | SMS notifications | Yes |

## API Contract

### Get User Preferences

```http
GET /api/v1/notifications/preferences
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "userId": "user_123",
      "channel": "telegram",
      "category": "portfolio_updates",
      "enabled": true,
      "quietHours": null,
      "frequency": "immediate",
      "updatedAt": "2024-09-28T12:00:00Z",
      "updatedBy": "user"
    }
  ]
}
```

### Update Preference

```http
PUT /api/v1/notifications/preferences
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "channel": "telegram",
  "category": "portfolio_updates",
  "enabled": true,
  "quietHours": {
    "enabled": true,
    "startHour": 22,
    "endHour": 8,
    "timezone": "America/New_York"
  },
  "frequency": "immediate"
}
```

### Enable/Disable Channel

```http
POST /api/v1/notifications/enable-channel
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "channel": "telegram"
}
```

```http
POST /api/v1/notifications/disable-channel
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "channel": "telegram"
}
```

### Unsubscribe

```http
POST /api/v1/notifications/unsubscribe
Content-Type: application/json

{
  "token": "abc123:timestamp",
  "channel": "telegram",
  "category": "marketing",
  "reason": "Too many notifications"
}
```

### Get Audit Log

```http
GET /api/v1/notifications/audit-log?limit=50
Authorization: Bearer <jwt_token>
```

## Unsubscribe Flow

### Step 1: Generate Unsubscribe Link

When sending a notification, include an unsubscribe link:

```
https://api.neurowealth.com/notifications/unsubscribe?token=<token>&channel=telegram
```

The token is generated using:
```typescript
const token = generateUnsubscribeToken(userId)
```

### Step 2: User Clicks Link

User is presented with a confirmation page showing:
- Which channel they're unsubscribing from
- Which categories will be affected
- Optional reason field
- Confirmation button

### Step 3: Process Unsubscribe

```typescript
const confirmation = await processUnsubscribe({
  userId: 'user_123',
  channel: 'telegram',
  category: 'marketing', // Optional - if omitted, unsubscribes from all
  token: request.query.token,
  reason: request.body.reason,
}, {
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
})
```

### Step 4: Confirmation

User receives confirmation that preferences have been updated.

## Quiet Hours

Users can configure quiet hours to suppress notifications during specific times:

```typescript
{
  "quietHours": {
    "enabled": true,
    "startHour": 22, // 10 PM
    "endHour": 8,    // 8 AM
    "timezone": "America/New_York"
  }
}
```

**Rules:**
- Quiet hours apply per channel
- Critical alerts (risk_alerts, system_updates) bypass quiet hours
- Overnight quiet hours (start > end) are supported
- Timezone-aware calculations

## Frequency Control

Users can control notification frequency:

| Frequency | Behavior |
|-----------|----------|
| `immediate` | Send as soon as event occurs |
| `daily` | Batch and send once per day at 9 AM user time |
| `weekly` | Batch and send once per week on Monday at 9 AM |

## Audit Trail

All preference changes are logged:

```typescript
type NotificationPreferenceAuditLog = {
  id: string
  userId: string
  action: 'enabled' | 'disabled' | 'updated' | 'unsubscribed'
  channel: NotificationChannel
  category: NotificationCategory
  previousValue: boolean
  newValue: boolean
  changedBy: 'user' | 'admin' | 'system'
  changedAt: Date
  metadata?: Record<string, unknown>
}
```

**Logged metadata includes:**
- IP address and user agent for user-initiated changes
- Admin reason for admin-initiated changes
- Quiet hours and frequency changes
- Unsubscribe reasons

## Testing

### Unit Tests

```typescript
describe('Notification Service', () => {
  it('should enable a preference', async () => {
    const preference = await setPreference(
      'user_123',
      'telegram',
      'portfolio_updates',
      true
    )
    expect(preference.enabled).toBe(true)
  })

  it('should respect quiet hours', async () => {
    await setPreference('user_123', 'telegram', 'portfolio_updates', true, {
      quietHours: {
        enabled: true,
        startHour: 22,
        endHour: 8,
        timezone: 'America/New_York'
      }
    })

    const shouldSend = await shouldSendNotification(
      'user_123',
      'telegram',
      'portfolio_updates'
    )
    // Depends on current time
  })

  it('should process unsubscribe', async () => {
    const token = generateUnsubscribeToken('user_123')
    const confirmation = await processUnsubscribe({
      userId: 'user_123',
      channel: 'telegram',
      category: 'marketing',
      token,
      reason: 'Too many notifications'
    })
    expect(confirmation.categories).toContain('marketing')
  })
})
```

### Integration Tests

1. **Preference Update Flow**: Update preference → Verify audit log → Verify notification behavior
2. **Unsubscribe Flow**: Generate token → Process unsubscribe → Verify preferences disabled
3. **Quiet Hours**: Set quiet hours → Verify suppression during quiet hours → Verify bypass for critical alerts
4. **Audit Trail**: Make multiple changes → Verify all logged → Verify metadata preserved

## Security Considerations

### Token Security
- Unsubscribe tokens expire after 7 days
- Tokens are hash-based with secret salt
- Tokens are single-use (marked as used after redemption)

### Rate Limiting
- Preference updates: 10 per minute per user
- Unsubscribe requests: 5 per minute per IP
- Audit log access: 30 per minute per user

### Access Control
- Users can only modify their own preferences
- Admins can modify any user's preferences (logged as admin changes)
- Audit log is read-only for users

## Compliance

### GDPR
- Right to opt-out: One-click unsubscribe from all channels
- Data portability: Export all preferences and audit log
- Consent tracking: All opt-ins logged with timestamp and source

### CAN-SPAM
- Clear unsubscribe mechanism in all marketing communications
- Unsubscribe requests processed within 10 business days
- Physical mailing address included in marketing emails

## Implementation References

- **Service**: `src/notifications/service.ts`
- **Types**: `src/notifications/types.ts`
- **Routes**: `src/routes/notifications.ts` (to be created)
- **Tests**: `tests/notifications/` (to be created)
