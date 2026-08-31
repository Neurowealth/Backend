import { config } from '../../config'
import { logger } from '../../utils/logger'
import {
  AudioInput,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionUnavailableError,
  UnsupportedAudioError,
  isSupportedAudioType,
} from './types'

/**
 * Deepgram speech-to-text provider (#400).
 *
 * The second STT vendor behind {@link TranscriptionProvider}, wired into the
 * registry as the automatic fallback for WhatsApp voice notes when the primary
 * (OpenAI) provider is down. Talks to the v1 `listen` REST endpoint directly
 * via global fetch (Node 18+) — no vendor SDK.
 *
 * Deepgram natively returns a per-alternative confidence in [0,1], which maps
 * straight onto the handler's low-confidence gate.
 *
 * Privacy: the audio buffer is held only for the duration of the request and
 * is never written to disk. See docs/WHATSAPP_VOICE.md.
 */

interface DeepgramAlternative {
  transcript: string
  confidence: number
}

interface DeepgramChannel {
  alternatives: DeepgramAlternative[]
}

interface DeepgramResponse {
  results?: {
    channels?: DeepgramChannel[]
  }
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'deepgram'

  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    if (!isSupportedAudioType(audio.contentType)) {
      throw new UnsupportedAudioError(
        `Unsupported audio content type: ${audio.contentType}`
      )
    }

    const apiKey = config.transcription.deepgramApiKey
    if (!apiKey) {
      // Missing credentials is an availability problem from the user's POV.
      throw new TranscriptionUnavailableError(
        'Transcription provider is not configured (missing DEEPGRAM_API_KEY)'
      )
    }

    const url = new URL(config.transcription.deepgramApiUrl)
    url.searchParams.set('model', config.transcription.deepgramModel)
    url.searchParams.set('punctuate', 'true')

    let response: Response
    try {
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        config.httpClient.timeoutMs
      )
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Token ${apiKey}`,
            'Content-Type':
              audio.contentType.split(';')[0]?.trim() || 'audio/ogg',
          },
          body: new Uint8Array(audio.buffer),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      // Network error, DNS failure, timeout/abort — provider is unavailable.
      throw new TranscriptionUnavailableError(
        `Transcription request failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // 4xx on the audio itself (e.g. unprocessable format) → unsupported;
      // everything else (5xx, 429, auth) → unavailable/outage.
      if (
        response.status === 400 ||
        response.status === 415 ||
        response.status === 422
      ) {
        throw new UnsupportedAudioError(
          `Provider rejected the audio (HTTP ${response.status})`
        )
      }
      logger.warn(
        `[Transcription] Deepgram returned HTTP ${response.status}: ${detail.slice(0, 200)}`
      )
      throw new TranscriptionUnavailableError(
        `Transcription provider error (HTTP ${response.status})`
      )
    }

    let payload: DeepgramResponse
    try {
      payload = (await response.json()) as DeepgramResponse
    } catch (err) {
      throw new TranscriptionUnavailableError(
        `Could not parse transcription response: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const alternative = payload.results?.channels?.[0]?.alternatives?.[0]
    const text = (alternative?.transcript ?? '').trim()

    const confidence =
      typeof alternative?.confidence === 'number'
        ? Math.max(0, Math.min(1, alternative.confidence))
        : // No confidence in the payload (shouldn't happen); treat as mid
          // confidence so a clear short command isn't force-rejected.
          0.7

    return { text, confidence }
  }
}
