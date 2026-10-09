import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';

/**
 * Turns a WhatsApp voice note into text, so it can be answered like a typed message.
 *
 * Speaks the OpenAI-compatible `POST /audio/transcriptions` API (multipart: `file`, `model`), which
 * OpenAI, most resellers and many gateways serve. It reuses the reasoning settings (`AI_BASE_URL`,
 * `AI_API_KEY`) unless `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_API_KEY` point somewhere else, so one
 * key can do both. `TRANSCRIBE_MODEL` defaults to `whisper-1`.
 *
 * Fail-open: anything that goes wrong yields null, and the bot says it could not hear the note —
 * a transcription outage must never cost the person an answer to their next typed message.
 */
@Injectable()
export class VoiceTranscriber {
  private readonly logger = createLogger('VoiceTranscriber');

  /** Notes longer than this are not sent for transcription (WhatsApp voice notes are far smaller). */
  static readonly MAX_BYTES = 8 * 1024 * 1024;

  private settings(): { url: string; key: string; model: string; language: string | null } | null {
    const url = (process.env.TRANSCRIBE_BASE_URL?.trim() || process.env.AI_BASE_URL?.trim() || '').replace(/\/+$/, '');
    const key = process.env.TRANSCRIBE_API_KEY?.trim() || process.env.AI_API_KEY?.trim() || '';
    const model = process.env.TRANSCRIBE_MODEL?.trim() || 'whisper-1';
    if (!url || !key || process.env.TRANSCRIBE_ENABLED === 'false') return null;
    return { url, key, model, language: process.env.TRANSCRIBE_LANGUAGE?.trim() || null };
  }

  isConfigured(): boolean {
    return this.settings() !== null;
  }

  /** The words in the note, or null when it could not be transcribed. */
  async transcribe(base64: string, mimeType: string | null): Promise<string | null> {
    const settings = this.settings();
    if (!settings || !base64) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > VoiceTranscriber.MAX_BYTES) return null;

    const type = (mimeType ?? 'audio/ogg').split(';')[0].trim().toLowerCase() || 'audio/ogg';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), `voice-note.${extensionFor(type)}`);
    form.append('model', settings.model);
    form.append('response_format', 'json');
    // Vocabulary hint: the words these notes are full of, in the mix people actually speak.
    form.append(
      'prompt',
      'Business voice note in Urdu, Roman Urdu or English about accounts: ledger, khata, hisaab, invoice, bill, ' +
        'trial balance, stock, payment, receivable, customer and item names.',
    );
    if (settings.language) form.append('language', settings.language);

    try {
      const response = await fetch(`${settings.url}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.key}` },
        body: form,
        signal: AbortSignal.timeout(45_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        this.logger.warn(`Transcription refused (${response.status}): ${raw.slice(0, 200)}`);
        return null;
      }
      let text = raw;
      try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        text = typeof parsed.text === 'string' ? parsed.text : '';
      } catch {
        // Some gateways answer plain text even when asked for JSON.
      }
      const heard = text.replace(/\s+/g, ' ').trim();
      return heard ? heard.slice(0, 2000) : null;
    } catch (error) {
      this.logger.warn(`Transcription failed: ${(error as Error).message}`);
      return null;
    }
  }
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/aac':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
      return 'webm';
    default:
      return 'ogg';
  }
}
