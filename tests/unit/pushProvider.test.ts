import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http2 from 'node:http2'
import {
  ApnsPushProvider,
  FcmPushProvider,
  INVALID_PUSH_TOKEN,
  PushRegistry,
} from '../../src/push/pushProvider'

describe('push providers', () => {
  const env = process.env
  const message = {
    deviceToken: 'device-token',
    title: 'Title',
    body: 'Body',
  }

  beforeEach(() => {
    process.env = { ...env }
  })

  afterEach(() => {
    process.env = env
    jest.restoreAllMocks()
  })

  describe('FCM HTTP v1', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const endpoint =
      'https://fcm.googleapis.com/v1/projects/project-id/messages:send'

    function mockSend(response: Response) {
      process.env.FCM_PROJECT_ID = 'project-id'
      process.env.FCM_CLIENT_EMAIL = 'service-account@example.com'
      process.env.FCM_PRIVATE_KEY = privateKey
      return jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'access-token', expires_in: 3600 })
          )
        )
        .mockResolvedValueOnce(response)
    }

    it('authenticates, sends the request, and returns the FCM acknowledgement', async () => {
      const name = 'projects/project-id/messages/notification-id'
      const fetchMock = mockSend(new Response(JSON.stringify({ name })))

      await expect(new FcmPushProvider().send(message)).resolves.toMatchObject({
        messageId: name,
        success: true,
      })
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          signal: expect.any(AbortSignal),
        })
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        endpoint,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer access-token',
          }),
          signal: expect.any(AbortSignal),
          body: JSON.stringify({
            message: {
              token: message.deviceToken,
              notification: { title: message.title, body: message.body },
            },
          }),
        })
      )
    })

    it('fails on a non-2xx response even if the body contains a name', async () => {
      const fetchMock = mockSend(
        new Response(JSON.stringify({ name: 'unexpected' }), { status: 503 })
      )
      await expect(new FcmPushProvider().send(message)).resolves.toMatchObject({
        success: false,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('marks unregistered tokens for deactivation', async () => {
      mockSend(
        new Response(
          JSON.stringify({
            error: {
              details: [
                {
                  '@type':
                    'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                  errorCode: 'UNREGISTERED',
                },
              ],
            },
          }),
          { status: 404 }
        )
      )
      await expect(new FcmPushProvider().send(message)).resolves.toMatchObject({
        success: false,
        error: INVALID_PUSH_TOKEN,
      })
    })
  })

  describe('APNs HTTP/2', () => {
    it.each([
      [200, '', { success: true, messageId: 'provider-id' }],
      [503, 'ServiceUnavailable', { success: false }],
      [410, 'Unregistered', { success: false, error: INVALID_PUSH_TOKEN }],
    ])(
      'maps HTTP %i after sending a request',
      async (status, reason, expected) => {
        process.env.APNS_KEY_ID = 'key-id'
        process.env.APNS_TEAM_ID = 'team-id'
        process.env.APNS_BUNDLE_ID = 'app.example'
        const { privateKey } = generateKeyPairSync('ec', {
          namedCurve: 'P-256',
        })
        process.env.APNS_PRIVATE_KEY = privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString()

        const stream = Object.assign(new EventEmitter(), {
          setEncoding: jest.fn(),
          end: jest.fn(() => {
            stream.emit('response', {
              ':status': status,
              'apns-id': 'provider-id',
            })
            stream.emit('data', JSON.stringify({ reason }))
            stream.emit('end')
          }),
        })
        const session = Object.assign(new EventEmitter(), {
          request: jest.fn(() => stream),
          close: jest.fn(),
          destroy: jest.fn(),
        })
        jest
          .spyOn(http2, 'connect')
          .mockReturnValue(session as unknown as http2.ClientHttp2Session)

        await expect(
          new ApnsPushProvider().send(message)
        ).resolves.toMatchObject(expected)
        expect(session.request).toHaveBeenCalledWith(
          expect.objectContaining({
            ':method': 'POST',
            ':path': '/3/device/device-token',
            'apns-topic': 'app.example',
          })
        )
        expect(stream.end).toHaveBeenCalledTimes(1)
        expect(session.close).toHaveBeenCalledTimes(1)
      }
    )
  })

  it('rejects unknown platforms and disables the mock platform outside test', () => {
    process.env.NODE_ENV = 'production'
    const registry = new PushRegistry()
    expect(() => registry.getProvider('androidd')).toThrow(
      'No push provider configured'
    )
    expect(() => registry.getProvider('mock')).toThrow(
      'No push provider configured'
    )
  })
})
