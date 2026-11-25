import { beforeSend } from '../../../src/telemetry/sentry'

describe('Sentry beforeSend', () => {
  it('recursively scrubs sensitive body, header, and query fields', () => {
    const event = {
      request: {
        data: {
          refreshToken: 'refresh',
          wallet: { secretKey: 'secret' },
          code: '123456',
        },
        headers: { Authorization: 'Bearer credential' },
        query_string: 'refreshToken=refresh&signature=signed&page=2',
      },
    } as any
    const scrubbed = beforeSend(event) as any
    expect(scrubbed.request.data).toEqual({
      refreshToken: '[Filtered]',
      wallet: { secretKey: '[Filtered]' },
      code: '[Filtered]',
    })
    expect(scrubbed.request.headers.Authorization).toBe('[Filtered]')
    expect(scrubbed.request.query_string).toBe(
      'refreshToken=[Filtered]&signature=[Filtered]&page=2'
    )
  })
})
