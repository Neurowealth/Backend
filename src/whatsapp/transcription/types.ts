/**
 * Speech-to-text abstraction for WhatsApp voice notes (#288).
 *
 * The concrete STT vendor MUST live behind {@link TranscriptionProvider} so it
 * is swappable and never hard-coded into the WhatsApp handler — mirroring how
 * the Stellar RPC client sits behind ResilientRpcClient and fiat vendors sit
 * behind FiatRampProvider. Nothing outside `src/whatsapp/transcription/*`
 * should reference a specific STT vendor.
 *
 * Privacy: implementations receive an in-memory audio buffer and MUST NOT
 * persist it. The raw audio is discarded once transcription returns. See
 * docs/WHATSAPP_VOICE.md.
 */

export interface TranscriptionResult {
  /** The recognized text. May be empty if the audio contained no speech. */
  text: string;
  /**
   * Confidence in [0, 1]. Providers that don't natively return a single score
   * should derive a reasonable proxy (e.g. from segment log-probabilities) so
   * the low-confidence gate in the handler has something to compare against.
   */
  confidence: number;
}

export interface AudioInput {
  /** Raw audio bytes downloaded from the messaging provider. */
  buffer: Buffer;
  /** MIME type reported by the messaging provider (e.g. "audio/ogg"). */
  contentType: string;
}

export interface TranscriptionProvider {
  /** Stable key (e.g. "openai"), used by the registry and logs. */
  readonly name: string;
  /**
   * Transcribe a complete audio note. Implementations should throw
   * {@link UnsupportedAudioError} for a format they cannot handle and
   * {@link TranscriptionUnavailableError} for an outage/transport failure, so
   * the handler can produce the right user-facing message for each.
   */
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
}

/**
 * The audio format/codec is one the provider cannot process. Distinct from an
 * outage so the handler can tell the user their audio wasn't understood rather
 * than that the service is down.
 */
export class UnsupportedAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAudioError';
    Object.setPrototypeOf(this, UnsupportedAudioError.prototype);
  }
}

/**
 * The provider is unreachable or returned a transport-level failure. Signals
 * the "voice isn't available right now, please type" fallback.
 */
export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionUnavailableError';
    Object.setPrototypeOf(this, TranscriptionUnavailableError.prototype);
  }
}

/**
 * Audio MIME types we accept before ever calling the provider. WhatsApp voice
 * notes are delivered as OGG/Opus; the others are accepted defensively for
 * clients that transcode. Anything else is rejected up front with a graceful
 * message rather than sent to the provider to fail opaquely.
 */
export const SUPPORTED_AUDIO_MIME_TYPES = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/mp3',
  'audio/amr',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
] as const;

/** True when `contentType` (ignoring any `;codecs=` suffix) is one we accept. */
export function isSupportedAudioType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  return (SUPPORTED_AUDIO_MIME_TYPES as readonly string[]).includes(base ?? '');
}
