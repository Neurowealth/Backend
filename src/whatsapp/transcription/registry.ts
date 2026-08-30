/**
 * Transcription provider registry (#288).
 *
 * The single lookup point mapping a provider key to a
 * {@link TranscriptionProvider}. The WhatsApp handler resolves the active
 * provider exclusively through {@link getDefaultTranscriptionProvider}, so
 * swapping STT vendors is a one-line registry change (plus config) with no edits
 * to the handler — the same pattern as the fiat provider registry.
 *
 * Multi-provider fallback (#400): the registry ships two vendors and
 * {@link getDefaultTranscriptionProvider} returns a composite that runs the
 * configured primary first and transparently retries the configured fallback
 * when the primary is unavailable.
 */
import { config } from '../../config'
import { logger } from '../../utils/logger'
import {
  AudioInput,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionUnavailableError,
} from './types'
import { OpenAiTranscriptionProvider } from './openaiProvider'
import { DeepgramTranscriptionProvider } from './deepgramProvider'

const registry = new Map<string, TranscriptionProvider>()

function register(provider: TranscriptionProvider): void {
  registry.set(provider.name, provider)
}

register(new OpenAiTranscriptionProvider())
register(new DeepgramTranscriptionProvider())

/** Resolve a provider by key. Throws if the key is unknown/unconfigured. */
export function getTranscriptionProvider(name: string): TranscriptionProvider {
  const provider = registry.get(name)
  if (!provider) {
    throw new Error(`Unknown transcription provider: "${name}"`)
  }
  return provider
}

/**
 * Composite provider (#400) that delegates to `primary` and, on a
 * {@link TranscriptionUnavailableError} (outage/transport/auth failure),
 * retries through `fallback`. An {@link UnsupportedAudioError} is NOT retried:
 * the audio itself is the problem, so a second vendor would fail identically —
 * and it is the handler's job to tell the user their format wasn't understood,
 * not that transcription is down.
 */
class FallbackTranscriptionProvider implements TranscriptionProvider {
  readonly name: string

  constructor(
    private readonly primary: TranscriptionProvider,
    private readonly fallback: TranscriptionProvider
  ) {
    this.name = `${primary.name}->${fallback.name}`
  }

  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    try {
      return await this.primary.transcribe(audio)
    } catch (err) {
      if (!(err instanceof TranscriptionUnavailableError)) {
        throw err
      }
      logger.warn(
        `[Transcription] Primary provider "${this.primary.name}" unavailable; falling back to "${this.fallback.name}": ${err.message}`
      )
      return await this.fallback.transcribe(audio)
    }
  }
}

/** The active provider (or fallback pair) for incoming voice notes. */
export function getDefaultTranscriptionProvider(): TranscriptionProvider {
  const primary = getTranscriptionProvider(config.transcription.provider)
  const fallback = getTranscriptionProvider(
    config.transcription.fallbackProvider
  )
  if (primary === fallback) {
    return primary
  }
  return new FallbackTranscriptionProvider(primary, fallback)
}

/**
 * Test/bootstrap seam: replace or add a provider implementation without going
 * through env configuration. Used by unit tests to inject a stub.
 */
export function registerTranscriptionProvider(
  provider: TranscriptionProvider
): void {
  register(provider)
}
