/** Fence-aware splitting of Markdown into size-bounded parts. */
import { utf8Bytes } from '../util/text.js';

export const RICH_MAX_BYTES = 30_000; // Telegram limit is 32 768 UTF-8 bytes — keep headroom
export const CLASSIC_MAX_CHARS = 3_600; // 4096 after entity parsing — keep headroom for markup

type Measure = (s: string) => number;

interface Block {
  text: string;
  fence?: { marker: string; info: string };
}

/** Split markdown into blocks at blank lines, never inside a code fence. */
function toBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let cur: string[] = [];
  let inFence: { marker: string; info: string } | null = null;
  let fenceLines: string[] = [];
  const flush = () => {
    if (cur.length) blocks.push({ text: cur.join('\n') });
    cur = [];
  };
  for (const line of lines) {
    if (inFence) {
      fenceLines.push(line);
      if (line.trim().startsWith(inFence.marker) && line.trim().replace(/[`~]/g, '') === '') {
        blocks.push({ text: fenceLines.join('\n'), fence: inFence });
        inFence = null;
        fenceLines = [];
      }
      continue;
    }
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      flush();
      inFence = { marker: m[1] as string, info: (m[2] ?? '').trim() };
      fenceLines = [line];
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    cur.push(line);
  }
  if (inFence) blocks.push({ text: fenceLines.join('\n'), fence: inFence });
  flush();
  return blocks;
}

/** Hard-split one oversized block. Code fences are closed and reopened per piece. */
function splitBlock(b: Block, max: number, measure: Measure): string[] {
  const out: string[] = [];
  if (b.fence) {
    const open = `${b.fence.marker}${b.fence.info}`;
    const close = b.fence.marker;
    const body = b.text.split('\n').slice(1);
    if (body.length && body[body.length - 1]?.trim().startsWith(b.fence.marker)) body.pop();
    let cur: string[] = [];
    const budget = max - measure(open) - measure(close) - 4;
    for (const line of body) {
      const candidate = [...cur, line].join('\n');
      if (measure(candidate) > budget && cur.length) {
        out.push(`${open}\n${cur.join('\n')}\n${close}`);
        cur = [];
      }
      cur.push(line.length > budget ? line.slice(0, budget) : line);
    }
    if (cur.length) out.push(`${open}\n${cur.join('\n')}\n${close}`);
    return out;
  }
  // Paragraph: split by lines, then sentences, then characters.
  let cur = '';
  const pieces = b.text.split(/(?<=\n)|(?<=[.!?…])\s+/);
  for (const piece of pieces) {
    const candidate = cur ? `${cur}${cur.endsWith('\n') ? '' : ' '}${piece}` : piece;
    if (measure(candidate) <= max) {
      cur = candidate;
      continue;
    }
    if (cur) out.push(cur.trim());
    if (measure(piece) <= max) {
      cur = piece;
      continue;
    }
    let chunk = '';
    for (const ch of Array.from(piece)) {
      if (measure(chunk + ch) > max) {
        out.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    cur = chunk;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function splitMarkdown(md: string, max: number, measure: Measure = utf8Bytes): string[] {
  if (measure(md) <= max) return [md];
  const parts: string[] = [];
  let cur = '';
  for (const b of toBlocks(md)) {
    const pieces = measure(b.text) > max ? splitBlock(b, max, measure) : [b.text];
    for (const piece of pieces) {
      const candidate = cur ? `${cur}\n\n${piece}` : piece;
      if (measure(candidate) <= max) {
        cur = candidate;
      } else {
        if (cur) parts.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [md.slice(0, max)];
}

export const charLength: Measure = (s) => s.length;
