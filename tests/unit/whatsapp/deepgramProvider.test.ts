// Deepgram transcription provider (#400). fetch is mocked so these tests are
// deterministic and offline; the key assertions are the request shape (auth
// header, endpoint) and the response parsing into { text, confidence }.
process.env.NODE_ENV = 'test'
process.env.STELLAR_NETWORK = 'testnet'
process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org'
process.env.STELLAR_AGENT_SECRET_KEY = 'S' + 'A'.repeat(55)
process.env.VAULT_CONTRACT_ID = 'C' + 'A'.repeat(55)
process.env.USDC_TOKEN_ADDRESS = 'C' + 'B'.repeat(55)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
process.env.DATABASE_URL = 'postgresql://localhost:5432/test'
process.env.JWT_SEED = '0'.repeat(64)
process.env.WALLET_ENCRYPTION_KEY = '0'.repeat(64)
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32)
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32)
process.env.DEEPGRAM_API_KEY = 'dg-test-key'
process.env.AI_MODE = 'local'

import { DeepgramTranscriptionProvider } from '../../../src/whatsapp/transcription/deepgramProvider'
import {
  TranscriptionUnavailableError,
  UnsupportedAudioError,
} from '../../../src/whatsapp/transcription/types'
import { config } from '../../../src/config'

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const provider = new DeepgramTranscriptionProvider()
const AUDIO = {
  buffer: Buffer.from('fake-audio-bytes'),
  contentType: 'audio/ogg',
}

afterEach(() => {
  jest.restoreAllMocks()
  ;(config.transcription as { deepgramApiKey: string }).deepgramApiKey =
    'dg-test-key'
})

describe('DeepgramTranscriptionProvider (#400)', () => {
  it('throws UnsupportedAudioError for an audio type it cannot process', async () => {
    await expect(
      provider.transcribe({
        buffer: Buffer.from('x'),
        contentType: 'audio/x-weird',
      })
    ).rejects.toThrow(UnsupportedAudioError)
  })

  it('throws TranscriptionUnavailableError when no API key is configured', async () => {
    ;(config.transcription as { deepgramApiKey: string }).deepgramApiKey = ''

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      TranscriptionUnavailableError
    )
  })

  it('sends the raw audio to the listen endpoint with a token auth header', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          channels: [
            { alternatives: [{ transcript: 'balance', confidence: 0.96 }] },
          ],
        },
      }),
    } as Response)

    const result = await provider.transcribe(AUDIO)

    expect(result.text).toBe('balance')
    expect(result.confidence).toBe(0.96)

    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('api.deepgram.com/v1/listen')
    expect(String(url)).toContain('model=nova-2')
    expect(options).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Token dg-test-key',
          'Content-Type': 'audio/ogg',
        }),
      })
    )
  })

  it('parses the native confidence and clamps it to [0,1]', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          channels: [
            { alternatives: [{ transcript: 'withdraw 5', confidence: 1.3 }] },
          ],
        },
      }),
    } as Response)

    const result = await provider.transcribe(AUDIO)

    expect(result.text).toBe('withdraw 5')
    expect(result.confidence).toBe(1)
  })

  it('maps an audio-rejected 4xx to UnsupportedAudioError', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 415,
      text: async () => 'unsupported media type',
    } as Response)

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      UnsupportedAudioError
    )
  })

  it('maps an upstream 5xx to TranscriptionUnavailableError', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    } as Response)

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      TranscriptionUnavailableError
    )
  })

  it('maps a transport failure to TranscriptionUnavailableError', async () => {
    jest
      .spyOn(global, 'fetch' as any)
      .mockRejectedValue(new Error('ECONNRESET'))

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      TranscriptionUnavailableError
    )
  })
})
