/** Small text helpers shared across modules. */
import { createHash, randomInt } from 'node:crypto';

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Truncate to at most `max` characters (code points), adding an ellipsis. */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join('') + ellipsis;
}

/** Keep the *end* of a string (for streaming reasoning previews). */
export function tail(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return '…' + chars.slice(chars.length - max + 1).join('');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() from empty list');
  return items[randomInt(items.length)] as T;
}

/** Deterministic pick (stable for the same seed string). */
export function pickSeeded<T>(items: readonly T[], seed: string): T {
  if (items.length === 0) throw new Error('pickSeeded() from empty list');
  const h = createHash('sha256').update(seed).digest();
  return items[h.readUInt32BE(0) % items.length] as T;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Random positive 31-bit id (non-zero) — used for draft ids. */
export function randomId31(): number {
  return randomInt(1, 2 ** 31 - 1);
}

export function shortId(): string {
  return randomInt(0, 36 ** 6).toString(36).padStart(6, '0');
}

/** Collapse whitespace and trim. */
export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Human "3m 12s" style duration. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Strip Markdown-ish formatting for TTS / previews. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' (formula) ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\|\|([\s\S]*?)\|\|/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~`#>=]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyRussian(s: string): boolean {
  const cyr = (s.match(/[\u0400-\u04FF]/g) ?? []).length;
  const lat = (s.match(/[A-Za-z]/g) ?? []).length;
  return cyr > 0 && cyr >= lat;
}
