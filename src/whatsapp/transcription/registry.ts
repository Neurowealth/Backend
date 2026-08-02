/**
 * Transcription provider registry (#288).
 *
 * The single lookup point mapping a provider key to a
 * {@link TranscriptionProvider}. The WhatsApp handler resolves the active
 * provider exclusively through {@link getDefaultTranscriptionProvider}, so
 * swapping STT vendors is a one-line registry change (plus config) with no edits
 * to the handler — the same pattern as the fiat provider registry.
 */
import { config } from '../../config'
import { TranscriptionProvider } from './types'
import { OpenAiTranscriptionProvider } from './openaiProvider'

const registry = new Map<string, TranscriptionProvider>()

function register(provider: TranscriptionProvider): void {
  registry.set(provider.name, provider)
}

// v1 ships a single provider. Add further vendors here — nothing else changes.
register(new OpenAiTranscriptionProvider())

/** Resolve a provider by key. Throws if the key is unknown/unconfigured. */
export function getTranscriptionProvider(name: string): TranscriptionProvider {
  const provider = registry.get(name)
  if (!provider) {
    throw new Error(`Unknown transcription provider: "${name}"`)
  }
  return provider
}

/** The active provider for incoming voice notes (from config). */
export function getDefaultTranscriptionProvider(): TranscriptionProvider {
  return getTranscriptionProvider(config.transcription.provider)
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
