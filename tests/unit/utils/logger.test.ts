import winston from 'winston'
import {
  logger,
  redactSensitiveData,
  scrubPayload,
  scrubFormat,
  DENY_LIST_KEYS,
  createCorrelatedLogger,
  logBackgroundJob,
} from '../../../src/utils/logger'

describe('Logger PII and Sensitive Data Scrubbing (#666)', () => {
  describe('redactSensitiveData string transformations', () => {
    it('redacts email local-part while preserving the domain', () => {
      expect(redactSensitiveData('User alice@example.com logged in')).toBe(
        'User ***@example.com logged in'
      )
      expect(
        redactSensitiveData('Contact support@corp.neuro.finance for help')
      ).toBe('Contact ***@corp.neuro.finance for help')
      expect(
        redactSensitiveData(
          'Notification sent to user.name+tag@sub.domain.co.uk'
        )
      ).toBe('Notification sent to ***@sub.domain.co.uk')
    })

    it('redacts phone numbers across multiple formats', () => {
      expect(redactSensitiveData('Call +1-555-123-4567 for support')).toBe(
        'Call ***-***-**** for support'
      )
      expect(redactSensitiveData('Dial 555-987-6543 today')).toBe(
        'Dial ***-***-**** today'
      )
      expect(redactSensitiveData('SMS to +1 (555) 234-5678')).toBe(
        'SMS to ***-***-****'
      )
      expect(redactSensitiveData('Mobile: +15551234567')).toBe(
        'Mobile: ***-***-****'
      )
    })

    it('does not incorrectly redact dates, timestamps or numeric amounts as phones', () => {
      const logMessage =
        'Report date 2026-10-22 with amount 1000000000 and id 1729600000123'
      expect(redactSensitiveData(logMessage)).toBe(logMessage)
    })

    it('redacts IPv4 addresses while preserving /24 subnet telemetry', () => {
      expect(redactSensitiveData('Connection from 192.168.1.42')).toBe(
        'Connection from 192.168.1.***'
      )
      expect(redactSensitiveData('Internal IP 10.200.5.15 connected')).toBe(
        'Internal IP 10.200.5.*** connected'
      )
      expect(redactSensitiveData('Localhost 127.0.0.1')).toBe(
        'Localhost 127.0.0.***'
      )
    })

    it('redacts full Stellar public keys keeping only first and last 4 chars', () => {
      const pubkey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'
      expect(redactSensitiveData(`Deposit from ${pubkey} processed`)).toBe(
        'Deposit from GAAZ...CWN7 processed'
      )
    })

    it('completely redacts Stellar secret keys', () => {
      const secretKey =
        'SB56XR7A6T4J73H7U5Z5YTY7U7I5I6J6K6L6M6N6O6P6Q6R6S6T6U6V6'
      expect(redactSensitiveData(`Agent key: ${secretKey}`)).toBe(
        'Agent key: [REDACTED_SECRET_KEY]'
      )
    })

    it('redacts EVM wallet addresses keeping only first and last 4 chars', () => {
      const evmAddress = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'
      expect(redactSensitiveData(`Contract caller ${evmAddress}`)).toBe(
        'Contract caller 0x71...976F'
      )
    })

    it('redacts tokens, Slack keys, Stripe keys, and 64-char hex strings', () => {
      expect(
        redactSensitiveData('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
      ).toMatch(/bear\*{4,}/i)
      expect(
        redactSensitiveData('sk-live-0123456789abcdef0123456789abcdef')
      ).toMatch(/sk-l\*{10,}/)
      expect(redactSensitiveData('xoxb-123456789-abcdef')).toMatch(/xoxb\*{5,}/)
      expect(
        redactSensitiveData(
          'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
        )
      ).toBe('a1b2************************************************************')
    })
  })

  describe('Field-level deny-list and deep payload scrubbing (scrubPayload)', () => {
    it('redacts deny-listed keys regardless of casing or position in key name', () => {
      const payload = {
        password: 'PlainTextPassword1!',
        userPassword: 'SecretPassword2@',
        secret: 'super-sensitive-secret',
        client_secret: 'oauth-client-secret-999',
        token: 'auth-token-12345',
        accessToken: 'jwt-access-token',
        authorization: 'Bearer token-abc',
        cookie: 'sessionId=abc123xyz',
        session_cookie: 'sid=456',
      }

      const scrubbed = scrubPayload(payload)

      for (const key of Object.keys(payload)) {
        expect(scrubbed[key as keyof typeof payload]).toBe('[REDACTED]')
      }
    })

    it('deeply scrubs nested objects and arrays containing PII and deny-listed keys', () => {
      const complexPayload = {
        event: 'auth.attempt',
        user: {
          id: 'usr_123',
          email: 'alice@domain.org',
          phone: '+1-555-555-0199',
          credentials: {
            password: 'my-password-123',
            pin: '1234',
          },
          wallets: [
            {
              chain: 'stellar',
              address:
                'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
            },
            {
              chain: 'ethereum',
              address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
            },
          ],
        },
        meta: {
          ip: '203.0.113.195',
          userAgent: 'Mozilla/5.0',
        },
      }

      const scrubbed = scrubPayload(complexPayload)

      expect(scrubbed.user.email).toBe('***@domain.org')
      expect(scrubbed.user.phone).toBe('***-***-****')
      expect(scrubbed.user.credentials.password).toBe('[REDACTED]')
      expect(scrubbed.user.wallets[0].address).toBe('GAAZ...CWN7')
      expect(scrubbed.user.wallets[1].address).toBe('0x71...976F')
      expect(scrubbed.meta.ip).toBe('203.0.113.***')
    })

    it('safely handles Error objects and circular references', () => {
      const err = new Error('Database connection failed for user test@corp.com')
      const scrubbedErr = scrubPayload(err)
      expect(scrubbedErr.message).toBe(
        'Database connection failed for user ***@corp.com'
      )

      const circular: any = { name: 'test' }
      circular.self = circular
      const scrubbedCircular = scrubPayload(circular)
      expect(scrubbedCircular.self).toBe('[Circular]')
    })
  })

  describe('Winston logger scrubbing pipeline and acceptance criteria', () => {
    let capturedLogs: any[] = []
    let testLogger: winston.Logger

    beforeEach(() => {
      capturedLogs = []
      const memoryTransport = new winston.transports.Console({
        format: winston.format.json(),
      })
      // Intercept log calls to collect emitted entries
      memoryTransport.log = (info: any, next: () => void) => {
        capturedLogs.push({ ...info })
        next()
      }

      testLogger = winston.createLogger({
        level: 'debug', // Debug mode enabled
        format: winston.format.combine(scrubFormat(), winston.format.json()),
        transports: [memoryTransport],
      })
    })

    it('ensures no raw email or phone appears in log output fixtures', () => {
      const rawEmail = 'victim@personal-email.com'
      const rawPhone = '+1-555-867-5309'
      const rawIp = '198.51.100.77'
      const rawWallet =
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'

      testLogger.info(`Login event for ${rawEmail} from ${rawIp}`, {
        user: {
          email: rawEmail,
          phone: rawPhone,
          wallet: rawWallet,
        },
        token: 'secret-auth-token-12345',
        cookie: 'sid=session_secret',
      })

      expect(capturedLogs).toHaveLength(1)
      const logString = JSON.stringify(capturedLogs[0])

      // Acceptance Criteria: No raw email or phone in log output fixtures
      expect(logString).not.toContain(rawEmail)
      expect(logString).not.toContain(rawPhone)
      expect(logString).not.toContain('198.51.100.77')
      expect(logString).not.toContain(rawWallet)
      expect(logString).not.toContain('secret-auth-token-12345')

      // Assert expected redacted representations
      expect(logString).toContain('***@personal-email.com')
      expect(logString).toContain('***-***-****')
      expect(logString).toContain('198.51.100.***')
      expect(logString).toContain('GAAZ...CWN7')
      expect(capturedLogs[0].token).toBe('[REDACTED]')
      expect(capturedLogs[0].cookie).toBe('[REDACTED]')
    })

    it('ensures debug log level and log sampling cannot bypass scrubbing', () => {
      const rawEmail = 'debug.trace@sample.org'
      const rawPhone = '555-444-3322'

      testLogger.debug(
        `Debug trace execution for ${rawEmail} with phone ${rawPhone}`,
        {
          password: 'debug_password_bypass_attempt',
          secret: 'internal_secret',
        }
      )

      expect(capturedLogs).toHaveLength(1)
      const logString = JSON.stringify(capturedLogs[0])

      expect(logString).not.toContain(rawEmail)
      expect(logString).not.toContain(rawPhone)
      expect(logString).not.toContain('debug_password_bypass_attempt')
      expect(logString).not.toContain('internal_secret')

      expect(capturedLogs[0].password).toBe('[REDACTED]')
      expect(capturedLogs[0].secret).toBe('[REDACTED]')
      expect(capturedLogs[0].message).toContain('***@sample.org')
      expect(capturedLogs[0].message).toContain('***-***-****')
    })

    it('scrubs PII when using child loggers and background job logger', () => {
      const rawEmail = 'worker@service.net'
      const childLogger = testLogger.child({
        service: 'worker_pool',
        assignedTo: rawEmail,
      })

      childLogger.info(`Processing job with email ${rawEmail}`)
      expect(capturedLogs).toHaveLength(1)
      expect(JSON.stringify(capturedLogs[0])).not.toContain(rawEmail)
      expect(capturedLogs[0].assignedTo).toBe('***@service.net')
    })
  })
})
