/**
 * NVIDIA-powered senses: eyes (vision/video), ears (ASR), voice (TTS) and
 * hands (FLUX image generation). All HTTP — no gRPC, no native deps.
 */
import type { Config } from '../config.js';
import { logger } from '../log.js';
import { TRANSCRIBE_PROMPT, VIDEO_PROMPT, VISION_PROMPT } from '../persona/alya.js';
import type { Emotion } from '../persona/mood.js';
import { plainText, truncate } from '../util/text.js';
import { durationSec, parseWav, pcmToMp3 } from './audio.js';
import { AIError, extractJson, type NvidiaClient } from './nvidia.js';

const log = logger('senses');

export class Senses {
  /** TTS voices that were rejected (e.g. an emotion suffix the server lacks). */
  private badVoices = new Set<string>();
  asrHttpBroken = false;

  constructor(
    private readonly ai: NvidiaClient,
    private readonly cfg: Config,
  ) {}

  // ------------------------------------------------------------ eyes

  async describeImage(image: Buffer, mime: string, question?: string, signal?: AbortSignal): Promise<string> {
    const prompt = question ? `${VISION_PROMPT}\n\nThe person also wrote: "${truncate(question, 500)}" — make sure your description covers what they ask about.` : VISION_PROMPT;
    const c = await this.ai.complete(
      {
        model: this.cfg.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
            ],
          },
        ],
        thinking: false,
        temperature: 0.2,
        max_tokens: 900,
      },
      { signal, priority: 'high' },
    );
    return c.content || '(the image could not be described)';
  }

  async describeVideo(video: Buffer, question?: string, signal?: AbortSignal): Promise<string> {
    const prompt = question ? `${VIDEO_PROMPT}\nThe person also wrote: "${truncate(question, 500)}".` : VIDEO_PROMPT;
    const c = await this.ai.complete(
      {
        model: this.cfg.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video.toString('base64')}` } },
            ],
          },
        ],
        thinking: false,
        temperature: 0.2,
        max_tokens: 900,
        extra: { mm_processor_kwargs: { use_audio_in_video: true } },
      },
      { signal, priority: 'high' },
    );
    return c.content || '(the video could not be described)';
  }

  // ------------------------------------------------------------ ears

  /** Speech → text. NVCF ASR over HTTP first, omni model as fallback. */
  async transcribe(audio: Buffer, mime: string, filename: string, signal?: AbortSignal): Promise<string> {
    if (this.cfg.asrFunctionId && !this.asrHttpBroken) {
      try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
        form.append('language', this.cfg.asrLanguage);
        const res = await this.ai.nvcf(this.cfg.asrFunctionId, '/v1/audio/transcriptions', form, { signal, priority: 'high', timeoutMs: 90_000 });
        const raw = res.body.toString('utf8').trim();
        const json = extractJson<{ text?: string }>(raw);
        const text = (json && typeof json.text === 'string' ? json.text : res.contentType.includes('json') ? '' : raw).trim();
        if (text) return text;
      } catch (err) {
        if (err instanceof AIError && err.kind === 'aborted') throw err;
        if (err instanceof AIError && (err.kind === 'model' || err.kind === 'bad_request')) {
          log.warn(`ASR HTTP endpoint unusable (${err.message}) — switching to omni fallback`);
          this.asrHttpBroken = err.kind === 'model';
        } else {
          log.warn(`ASR failed: ${(err as Error).message}`);
        }
      }
    }
    const format = mime.includes('mpeg') || filename.endsWith('.mp3') ? 'audio/mpeg' : mime.includes('wav') ? 'audio/wav' : mime || 'audio/ogg';
    const c = await this.ai.complete(
      {
        model: this.cfg.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'audio_url', audio_url: { url: `data:${format};base64,${audio.toString('base64')}` } },
              { type: 'text', text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
        thinking: false,
        temperature: 0,
        top_k: 1,
        max_tokens: 1500,
      },
      { signal, priority: 'high' },
    );
    return c.content.trim();
  }

  // ------------------------------------------------------------ voice

  /** Text → MP3 voice note bytes. */
  async synthesize(markdown: string, emotion?: Emotion, signal?: AbortSignal): Promise<{ audio: Buffer; seconds: number }> {
    if (!this.cfg.ttsFunctionId) throw new AIError('disabled', 'TTS is not configured');
    const text = prepareSpeech(markdown);
    if (!text) throw new AIError('bad_request', 'nothing to say');
    const base = this.cfg.ttsVoice;
    const voices: string[] = [];
    if (this.cfg.ttsEmotions && emotion && emotion !== 'neutral') {
      const suffix = emotion[0]!.toUpperCase() + emotion.slice(1);
      const v = `${base}.${suffix}`;
      if (!this.badVoices.has(v)) voices.push(v);
    }
    voices.push(base);
    let lastErr: unknown;
    for (const voice of voices) {
      try {
        const form = new FormData();
        form.append('text', text);
        form.append('language', this.cfg.ttsLanguage);
        form.append('voice', voice);
        form.append('encoding', 'LINEAR_PCM');
        form.append('sample_rate_hz', String(this.cfg.ttsSampleRate));
        const res = await this.ai.nvcf(this.cfg.ttsFunctionId, '/v1/audio/synthesize', form, { signal, priority: 'normal', timeoutMs: 60_000 });
        if (res.contentType.includes('json')) throw new AIError('bad_response', `TTS returned JSON: ${res.body.toString('utf8').slice(0, 200)}`);
        const pcm = parseWav(res.body, this.cfg.ttsSampleRate);
        if (pcm.samples.length < 100) throw new AIError('bad_response', 'TTS returned no audio');
        return { audio: pcmToMp3(pcm, 48), seconds: Math.max(1, Math.round(durationSec(pcm))) };
      } catch (err) {
        lastErr = err;
        if (err instanceof AIError && err.kind === 'aborted') throw err;
        if (voice !== base && err instanceof AIError && (err.kind === 'bad_request' || err.kind === 'model')) {
          this.badVoices.add(voice);
          continue;
        }
        if (voice !== base) continue;
      }
    }
    throw lastErr instanceof Error ? lastErr : new AIError('server', 'TTS failed');
  }

  // ------------------------------------------------------------ hands

  async generateImage(prompt: string, signal?: AbortSignal): Promise<{ image: Buffer; mime: string }> {
    const data = await this.ai.genai(
      this.cfg.imageModel,
      { prompt: truncate(prompt, 2000), width: 1024, height: 1024, steps: 4, seed: 0, cfg_scale: 0, mode: 'base', samples: 1 },
      { signal, priority: 'normal', timeoutMs: 120_000 },
    );
    const artifacts = (data.artifacts ?? data.images ?? data.data) as Array<Record<string, unknown>> | undefined;
    const first = artifacts?.[0];
    const reason = String(first?.finishReason ?? first?.finish_reason ?? '');
    if (/filter|blocked|safety/i.test(reason)) throw new AIError('bad_request', 'image blocked by the safety filter');
    const b64 = (first?.base64 ?? first?.b64_json ?? data.image) as string | undefined;
    if (!b64) throw new AIError('bad_response', `no image in response (${JSON.stringify(data).slice(0, 160)})`);
    const image = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const mime = image.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg';
    return { image, mime };
  }
}

/** Prepare markdown for speech: plain text, no code, bounded length. */
export function prepareSpeech(markdown: string): string {
  const withoutSpoilerMarks = markdown.replace(/\|\|\(([^)]*)\)\|\|/g, '').replace(/\|\|([^|]*)\|\|/g, '$1');
  let t = plainText(withoutSpoilerMarks)
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 900) {
    const cut = t.slice(0, 900);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = (end > 300 ? cut.slice(0, end + 1) : cut) + ' …the rest is in my message!';
  }
  return t;
}

const NSFW_RE = /\b(nude|naked|nsfw|porn|sex|sexual|hentai|lewd|erotic|topless|undress|lingerie|boobs?|breasts?|genitals?|fetish)\b/i;
const MINOR_RE = /\b(child|children|kid|kids|minor|teen|underage|loli|shota|schoolgirl|little girl|little boy)\b/i;

/** Quick local safety gate for image prompts (the model is also instructed). */
export function imagePromptProblem(prompt: string): string | null {
  if (NSFW_RE.test(prompt)) return 'nsfw';
  if (MINOR_RE.test(prompt) && /\b(sexy|hot|seductive|bikini|kiss)\b/i.test(prompt)) return 'minor';
  return null;
}
