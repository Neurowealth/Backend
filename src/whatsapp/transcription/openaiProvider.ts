import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  AudioInput,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionUnavailableError,
  UnsupportedAudioError,
  isSupportedAudioType,
} from './types';

/**
 * OpenAI Whisper transcription provider (#288).
 *
 * The one concrete {@link TranscriptionProvider} shipped in v1. Uses the
 * `verbose_json` response so we can derive a confidence score from segment
 * average log-probabilities (Whisper does not return a single top-level
 * confidence). Talks to the HTTP API directly via global fetch/FormData
 * (Node 18+) so no vendor SDK is pulled in.
 *
 * Privacy: the audio buffer is held only for the duration of the request and
 * is never written to disk. See docs/WHATSAPP_VOICE.md.
 */

interface WhisperSegment {
  avg_logprob?: number;
}

interface WhisperVerboseResponse {
  text?: string;
  segments?: WhisperSegment[];
}

/** Map a filename extension onto the content type for the multipart part. */
function filenameFor(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  const ext =
    base === 'audio/mpeg' || base === 'audio/mp3'
      ? 'mp3'
      : base === 'audio/mp4'
        ? 'm4a'
        : base === 'audio/wav' || base === 'audio/x-wav'
          ? 'wav'
          : base === 'audio/webm'
            ? 'webm'
            : base === 'audio/amr'
              ? 'amr'
              : 'ogg';
  return `voice-note.${ext}`;
}

/**
 * Convert Whisper's mean segment log-probability into a [0,1] confidence.
 * exp(avg_logprob) is the geometric-mean token probability, which is a
 * reasonable, monotonic proxy for "how sure was the model". Clamped to [0,1].
 */
export function confidenceFromSegments(segments: WhisperSegment[]): number {
  const logprobs = segments
    .map((s) => s.avg_logprob)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (logprobs.length === 0) {
    // No per-segment data (e.g. very short clip). Treat as mid confidence so a
    // clear short command isn't force-rejected, but a garbled one still can be
    // caught by the parser falling through to 'unknown'.
    return 0.7;
  }

  const mean = logprobs.reduce((a, b) => a + b, 0) / logprobs.length;
  const conf = Math.exp(mean);
  return Math.max(0, Math.min(1, conf));
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai';

  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    if (!isSupportedAudioType(audio.contentType)) {
      throw new UnsupportedAudioError(
        `Unsupported audio content type: ${audio.contentType}`,
      );
    }

    const apiKey = config.transcription.openaiApiKey;
    if (!apiKey) {
      // Missing credentials is an availability problem from the user's POV.
      throw new TranscriptionUnavailableError(
        'Transcription provider is not configured (missing OPENAI_API_KEY)',
      );
    }

    const form = new FormData();
    const blob = new Blob([audio.buffer], {
      type: audio.contentType.split(';')[0]?.trim() || 'audio/ogg',
    });
    form.append('file', blob, filenameFor(audio.contentType));
    form.append('model', config.transcription.model);
    form.append('response_format', 'verbose_json');

    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.httpClient.timeoutMs,
      );
      try {
        response = await fetch(config.transcription.apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Network error, DNS failure, timeout/abort — provider is unavailable.
      throw new TranscriptionUnavailableError(
        `Transcription request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 4xx on the audio itself (e.g. unprocessable format) → unsupported;
      // everything else (5xx, 429, auth) → unavailable/outage.
      if (response.status === 400 || response.status === 415) {
        throw new UnsupportedAudioError(
          `Provider rejected the audio (HTTP ${response.status})`,
        );
      }
      logger.warn(
        `[Transcription] OpenAI returned HTTP ${response.status}: ${detail.slice(0, 200)}`,
      );
      throw new TranscriptionUnavailableError(
        `Transcription provider error (HTTP ${response.status})`,
      );
    }

    let payload: WhisperVerboseResponse;
    try {
      payload = (await response.json()) as WhisperVerboseResponse;
    } catch (err) {
      throw new TranscriptionUnavailableError(
        `Could not parse transcription response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = (payload.text ?? '').trim();
    const confidence = confidenceFromSegments(payload.segments ?? []);
    return { text, confidence };
  }
}
