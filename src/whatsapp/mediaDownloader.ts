import { config } from '../config';
import { logger } from '../utils/logger';
import {
  TranscriptionUnavailableError,
  UnsupportedAudioError,
  isSupportedAudioType,
} from './transcription/types';

/**
 * Download an inbound WhatsApp media attachment from Twilio (#288).
 *
 * Twilio media URLs are protected by HTTP basic auth using the account SID and
 * auth token. We fetch the bytes into memory only — the buffer is handed to the
 * transcription provider and then discarded; nothing is written to disk (see
 * docs/WHATSAPP_VOICE.md).
 *
 * Twilio often 302-redirects the MediaUrl to a signed CDN URL; global fetch
 * follows redirects by default, and the CDN response carries the real
 * Content-Type, which we trust over the webhook's MediaContentType field.
 */

export interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

/** Max audio we will pull into memory. WhatsApp voice notes are far smaller. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // 16 MB

export async function downloadTwilioMedia(
  mediaUrl: string,
  declaredContentType: string,
): Promise<DownloadedMedia> {
  // Reject clearly-unsupported formats before spending a network round-trip.
  // The authoritative check happens again on the downloaded Content-Type.
  if (declaredContentType && !isSupportedAudioType(declaredContentType)) {
    throw new UnsupportedAudioError(
      `Unsupported audio content type: ${declaredContentType}`,
    );
  }

  const sid = config.whatsapp.twilioSid;
  const token = config.whatsapp.twilioToken;
  if (!sid || !token) {
    throw new TranscriptionUnavailableError(
      'Twilio credentials not configured for media download',
    );
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.httpClient.timeoutMs,
    );
    try {
      response = await fetch(mediaUrl, {
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throw new TranscriptionUnavailableError(
      `Media download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    logger.warn(`[Media] Twilio media download HTTP ${response.status}`);
    throw new TranscriptionUnavailableError(
      `Media download error (HTTP ${response.status})`,
    );
  }

  const resolvedType =
    response.headers.get('content-type')?.split(';')[0]?.trim() ||
    declaredContentType;

  if (!isSupportedAudioType(resolvedType)) {
    throw new UnsupportedAudioError(
      `Unsupported audio content type: ${resolvedType}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new UnsupportedAudioError(
      `Audio is too large (${arrayBuffer.byteLength} bytes)`,
    );
  }

  return { buffer: Buffer.from(arrayBuffer), contentType: resolvedType };
}
