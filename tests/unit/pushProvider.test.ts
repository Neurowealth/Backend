import {
  FcmPushProvider,
  PushRegistry,
} from '../../src/push/pushProvider'

describe('push providers', () => {
  const message = {
    deviceToken: 'device-token',
    title: 'Title',
    body: 'Body',
  }

  afterEach(() => {
    delete process.env.FCM_SERVER_KEY
    jest.restoreAllMocks()
  })

  it('attempts an authenticated FCM send and only reports the provider acknowledgement', async () => {
    process.env.FCM_SERVER_KEY = 'server-key'
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message_id: 'fcm-message-id' }), {
          status: 200,
        })
      )

    await expect(new FcmPushProvider().send(message)).resolves.toMatchObject({
      messageId: 'fcm-message-id',
      success: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://fcm.googleapis.com/fcm/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'key=server-key',
        }),
      })
    )
  })

  it('does not route unknown platforms to the mock provider', () => {
    expect(() => new PushRegistry().getProvider('androidd')).toThrow(
      'No push provider configured'
    )
  })
})
