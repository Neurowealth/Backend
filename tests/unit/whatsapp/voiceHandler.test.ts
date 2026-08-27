// WhatsApp voice-note handling (#288). Fixture audio stands in for real bytes;
// the media download and STT provider are mocked so these tests are
// deterministic and offline. The security-critical assertion is that a
// voice-originated financial intent NEVER executes on the first pass.
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
// Force the regex fast-path only, so no live Claude call is attempted.
process.env.AI_MODE = 'local'

import fs from 'fs'
import path from 'path'

import { downloadTwilioMedia } from '../../../src/whatsapp/mediaDownloader'
import {
  UnsupportedAudioError,
  TranscriptionUnavailableError,
  type TranscriptionProvider,
} from '../../../src/whatsapp/transcription/types'
import { registerTranscriptionProvider } from '../../../src/whatsapp/transcription/registry'

jest.mock('../../../src/whatsapp/mediaDownloader', () => ({
  downloadTwilioMedia: jest.fn(),
}))
jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Stub the custodial-wallet creation the user store triggers, so tests don't
// touch Stellar/crypto.
jest.mock('../../../src/stellar/wallet', () => ({
  createCustodialWallet: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
  getWalletByUserId: jest
    .fn()
    .mockResolvedValue({ publicKey: 'G' + 'A'.repeat(55) }),
}))

import { handleWhatsAppMessage } from '../../../src/whatsapp/handler'
import {
  getUserForTests,
  clearUsersForTests,
} from '../../../src/whatsapp/userManager'
import { clearAllPendingConfirmations } from '../../../src/whatsapp/pendingConfirmations'

const mockDownload = downloadTwilioMedia as jest.Mock

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '../../fixtures/audio/voice-note.ogg')
)

const PHONE = 'whatsapp:+15551234567'
const MEDIA = {
  url: 'https://api.twilio.com/media/abc',
  contentType: 'audio/ogg',
}

/** Register a one-off transcription provider returning the given result/throw. */
function useProvider(
  impl: (buf: Buffer) => Promise<{ text: string; confidence: number }>
): void {
  const provider: TranscriptionProvider = {
    name: 'openai', // same key as the default, so registry lookup resolves to this
    transcribe: (audio) => impl(audio.buffer),
  }
  registerTranscriptionProvider(provider)
}

/** Verify + fund a user so financial intents can pass balance checks. */
async function verifiedUser(phone: string, balance = 1000): Promise<void> {
  await handleWhatsAppMessage(phone, 'hello') // creates user, sends OTP
  const user = getUserForTests(phone)!
  // Directly flip verification + balance via the test view.
  ;(user as any).verified = true
  ;(user as any).balance = balance
}

beforeEach(() => {
  jest.clearAllMocks()
  clearUsersForTests()
  clearAllPendingConfirmations()
  mockDownload.mockResolvedValue({ buffer: FIXTURE, contentType: 'audio/ogg' })
})

describe('WhatsApp voice notes (#288)', () => {
  it('transcribes a clear read-only command and executes it directly', async () => {
    await verifiedUser(PHONE)
    useProvider(async () => ({ text: 'balance', confidence: 0.95 }))

    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    expect(mockDownload).toHaveBeenCalledWith(MEDIA.url, MEDIA.contentType)
    expect(res.body).toMatch(/balance/i)
  })

  it('does NOT execute a voice-originated withdraw on the first pass — asks to confirm', async () => {
    await verifiedUser(PHONE, 500)
    useProvider(async () => ({ text: 'withdraw 50', confidence: 0.95 }))

    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    // Confirmation prompt, NOT a withdrawal confirmation.
    expect(res.body).toMatch(/confirm/i)
    expect(res.body).toMatch(/withdraw 50/i)
    // Balance untouched — nothing executed.
    expect(getUserForTests(PHONE)!.balance).toBe(500)
  })

  it('executes the withdraw only after an affirmative reply (text)', async () => {
    await verifiedUser(PHONE, 500)
    useProvider(async () => ({ text: 'withdraw 50', confidence: 0.95 }))

    await handleWhatsAppMessage(PHONE, '', MEDIA) // parks confirmation
    const res = await handleWhatsAppMessage(PHONE, 'yes') // text confirm

    expect(res.body).toMatch(/withdrawal request received/i)
    expect(getUserForTests(PHONE)!.balance).toBe(450)
  })

  it('accepts a voice "yes" as confirmation of a voice-originated action', async () => {
    await verifiedUser(PHONE, 500)
    useProvider(async () => ({ text: 'withdraw 50', confidence: 0.95 }))
    await handleWhatsAppMessage(PHONE, '', MEDIA) // parks confirmation

    // Confirmation arrives as a voice note saying "yes".
    useProvider(async () => ({ text: 'yes', confidence: 0.95 }))
    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    expect(res.body).toMatch(/withdrawal request received/i)
    expect(getUserForTests(PHONE)!.balance).toBe(450)
  })

  it('cancels the pending action on a negative reply without executing', async () => {
    await verifiedUser(PHONE, 500)
    useProvider(async () => ({ text: 'withdraw 50', confidence: 0.95 }))
    await handleWhatsAppMessage(PHONE, '', MEDIA)

    const res = await handleWhatsAppMessage(PHONE, 'no')

    expect(res.body).toMatch(/cancel/i)
    expect(getUserForTests(PHONE)!.balance).toBe(500)
  })

  it('asks to repeat on a low-confidence transcription instead of parsing', async () => {
    await verifiedUser(PHONE)
    useProvider(async () => ({ text: 'withdraw 50', confidence: 0.2 }))

    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    expect(res.body).toMatch(/repeat|type your command/i)
    expect(getUserForTests(PHONE)!.balance).toBe(1000)
  })

  it('responds gracefully to an unsupported audio format', async () => {
    await verifiedUser(PHONE)
    mockDownload.mockRejectedValue(
      new UnsupportedAudioError('Unsupported audio content type: audio/x-weird')
    )

    const res = await handleWhatsAppMessage(PHONE, '', {
      url: MEDIA.url,
      contentType: 'audio/x-weird',
    })

    expect(res.body).toMatch(/format|type your command/i)
  })

  it('responds with a fallback when the transcription provider is down', async () => {
    await verifiedUser(PHONE)
    useProvider(async () => {
      throw new TranscriptionUnavailableError('provider 503')
    })

    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    expect(res.body).toMatch(/aren't available right now|type your command/i)
  })

  it('falls through to unknown for transcribed nonsense (same as typed nonsense)', async () => {
    await verifiedUser(PHONE)
    useProvider(async () => ({ text: 'asdfghjkl qwerty', confidence: 0.95 }))

    const res = await handleWhatsAppMessage(PHONE, '', MEDIA)

    expect(res.body).toMatch(/didn't understand/i)
  })

  it('does not require confirmation for a typed (non-voice) withdraw', async () => {
    await verifiedUser(PHONE, 500)

    const res = await handleWhatsAppMessage(PHONE, 'withdraw 50')

    expect(res.body).toMatch(/withdrawal request received/i)
    expect(getUserForTests(PHONE)!.balance).toBe(450)
  })
})
