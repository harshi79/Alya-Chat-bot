/** WAV parsing and PCM → MP3 encoding (pure JS, for Telegram voice notes). */
import { Mp3Encoder } from '@breezystack/lamejs';

export interface Pcm {
  sampleRate: number;
  samples: Int16Array; // mono
}

/** Parse a PCM16 WAV (RIFF). Non-RIFF input is treated as raw PCM16 mono at `fallbackRate`. */
export function parseWav(buf: Buffer, fallbackRate: number): Pcm {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    let sampleRate = fallbackRate;
    let channels = 1;
    let bits = 16;
    let data: Buffer | null = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      let size = buf.readUInt32LE(off + 4);
      const start = off + 8;
      if (size === 0xffffffff || start + size > buf.length) size = buf.length - start; // streaming WAVs
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(start + 2);
        sampleRate = buf.readUInt32LE(start + 4);
        bits = buf.readUInt16LE(start + 14);
      } else if (id === 'data') {
        data = buf.subarray(start, start + size);
        break;
      }
      off = start + size + (size % 2);
    }
    if (!data) throw new Error('WAV has no data chunk');
    if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits}`);
    return { sampleRate, samples: downmix(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length - (data.length % 2)))), channels) };
  }
  const even = buf.subarray(0, buf.length - (buf.length % 2));
  return { sampleRate: fallbackRate, samples: new Int16Array(even.buffer.slice(even.byteOffset, even.byteOffset + even.length)) };
}

function downmix(interleaved: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c] as number;
    out[f] = Math.round(sum / channels);
  }
  return out;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** Resample (linear) to the nearest MP3-legal rate when needed. */
function toMp3Rate(pcm: Pcm): Pcm {
  if (MP3_RATES.includes(pcm.sampleRate)) return pcm;
  const target = MP3_RATES.reduce((best, r) => (Math.abs(r - pcm.sampleRate) < Math.abs(best - pcm.sampleRate) ? r : best), 22050);
  const ratio = pcm.sampleRate / target;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(pcm.samples.length - 1, i0 + 1);
    const frac = x - i0;
    out[i] = Math.round((pcm.samples[i0] as number) * (1 - frac) + (pcm.samples[i1] as number) * frac);
  }
  return { sampleRate: target, samples: out };
}

export function pcmToMp3(input: Pcm, kbps = 48): Buffer {
  const pcm = toMp3Rate(input);
  const enc = new Mp3Encoder(1, pcm.sampleRate, kbps);
  const chunks: Buffer[] = [];
  const block = 1152;
  for (let i = 0; i < pcm.samples.length; i += block) {
    const out = enc.encodeBuffer(pcm.samples.subarray(i, i + block));
    if (out.length) chunks.push(Buffer.from(out.buffer, out.byteOffset, out.length));
  }
  const end = enc.flush();
  if (end.length) chunks.push(Buffer.from(end.buffer, end.byteOffset, end.length));
  return Buffer.concat(chunks);
}

export function durationSec(pcm: Pcm): number {
  return pcm.samples.length / pcm.sampleRate;
}

/** Build a PCM16 mono WAV (used by tests and the mock server). */
export function makeWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
