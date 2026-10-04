import { fetchWithRetry } from '../../../src/utils/fetchWithRetry'

describe('fetchWithRetry response bounds', () => {
  afterEach(() => jest.restoreAllMocks())

  it('rejects a response larger than its configured byte limit', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payload: 'x'.repeat(100) }), {
        headers: { 'content-type': 'application/json' },
      })
    )

    await expect(
      fetchWithRetry('https://horizon.example/accounts/G', {
        retries: 1,
        maxResponseBytes: 16,
      })
    ).rejects.toThrow('Response body exceeds 16 byte limit')
  })
})
