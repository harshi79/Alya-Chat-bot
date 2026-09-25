/**
 * Make model-written Markdown safe and valid for Telegram Rich Messages.
 *
 * Rich Markdown accepts HTML, so an answer steered by a hostile document could
 * render fake buttons or reference media. We strip interactive / media tags in
 * a loop until the text stops changing (a nested pair can't re-assemble into a
 * working tag), drop media `tg://…?id=` links and Premium custom emoji, and turn
 * remote image embeds into plain links (a failed download would reject the
 * whole message). `tg://time` date-time links are kept — they're a free feature.
 */

/** Non-Telegram tags that must never reach the renderer (media fetches, forms, scripts, reasoning). */
const BLOCKED_TAGS = new Set([
  'figcaption', 'figure', 'script', 'style', 'iframe', 'img', 'video', 'audio', 'source', 'object', 'embed',
  'form', 'input', 'button', 'textarea', 'select', 'think', 'tool_call', 'link', 'meta', 'base',
]);
/** Telegram tags that are harmless in model output. Every other tg-* tag is stripped. */
const ALLOWED_TG_TAGS = new Set(['tg-spoiler', 'tg-map', 'tg-math', 'tg-math-block', 'tg-time', 'tg-reference']);

const ANY_TAG_RE = /<\s*\/?\s*([a-zA-Z][\w:-]*)[^>\n]{0,400}>/g;
const MEDIA_REF_RE = /tg:\/\/(?:photo|video|audio|voice|document|animation|emoji|sticker)\?id=[^\s)"'>]*/gi;

function isBlockedTag(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('tg-')) return !ALLOWED_TG_TAGS.has(n);
  return BLOCKED_TAGS.has(n);
}

/**
 * Split markdown into code (fenced blocks, inline spans) and prose. Code is
 * rendered verbatim by Telegram, so it is never rewritten.
 */
function segments(md: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\3[^\S\n]*(?=\n|$)|$)|`[^`\n]+`/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    let startIdx = m.index;
    if (m[1] === '\n') startIdx += 1;
    if (startIdx > last) out.push({ code: false, text: md.slice(last, startIdx) });
    out.push({ code: true, text: md.slice(startIdx, m.index + m[0].length) });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

function sanitizeProse(input: string): string {
  let s = input
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<tg-thinking>[\s\S]*?<\/tg-thinking>/gi, '');
  // Images: keep date-time links; custom emoji → alt text; media refs → gone; remote → link.
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt: string, url: string) => {
    if (/^tg:\/\/time\?/i.test(url)) return m;
    if (/^tg:\/\/emoji\?/i.test(url)) return alt;
    if (/^tg:\/\//i.test(url)) return alt ? alt : '';
    if (/^https?:\/\//i.test(url)) return `[${alt.trim() || 'image'}](${url})`;
    return alt;
  });
  // Links pointing at media refs lose the link.
  s = s.replace(/\[([^\]\n]*)\]\((tg:\/\/(?:photo|video|audio|voice|document|animation|emoji|sticker)\?id=[^)]*)\)/gi, '$1');
  // Strip until stable, so nested pairs can't re-assemble into a working tag.
  for (let i = 0; i < 12; i++) {
    const next = s.replace(ANY_TAG_RE, (tag: string, name: string) => (isBlockedTag(name) ? '' : tag)).replace(MEDIA_REF_RE, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

export function sanitizeModelMarkdown(input: string): string {
  let md = input.replace(/\r\n?/g, '\n');
  // An unclosed <tool_call> at the end (mid-stream) — hide everything after it.
  const open = md.search(/<tool_call>(?![\s\S]*<\/tool_call>)/i);
  if (open >= 0) md = md.slice(0, open);
  const out = segments(md)
    .map((seg) => (seg.code ? seg.text : sanitizeProse(seg.text)))
    .join('');
  return out.replace(/\n{4,}/g, '\n\n\n').trim();
}

/** Count code-fence lines (``` or ~~~ at line start). */
function fenceState(s: string): { open: boolean; fence: string } {
  let open = false;
  let fence = '```';
  for (const line of s.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const marker = m[1] as string;
    if (!open) {
      open = true;
      fence = marker;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      open = false;
    }
  }
  return { open, fence };
}

/** Remove fenced code so structural counting ignores code content. */
function withoutCode(s: string): string {
  return s.replace(/(^|\n)\s{0,3}(`{3,}|~{3,})[\s\S]*?(\n\s{0,3}\2[^\S\n]*(?=\n|$)|$)/g, '\n').replace(/`[^`\n]*`/g, '');
}

/**
 * Close constructs left open mid-stream so every draft parses:
 * code fences, $$ blocks, <details>/<summary>/<aside>, and a dangling partial tag.
 */
export function closeForStream(input: string): string {
  let s = input;
  // Dangling partial HTML tag at the very end, e.g. "<deta" or "</summ".
  s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?$/, '');
  // Dangling partial link/image at the end: "[text](http://exa" → drop the url part.
  s = s.replace(/(!?\[[^\]\n]*\])\([^)\n]*$/, '$1');

  const fs = fenceState(s);
  if (fs.open) return `${s}\n${fs.fence}`;

  const plain = withoutCode(s);
  const dollars = (plain.match(/\$\$/g) ?? []).length;
  if (dollars % 2 === 1) s += '\n$$';

  const count = (re: RegExp) => (plain.match(re) ?? []).length;
  const summaryOpen = count(/<summary\b[^>]*>/gi) - count(/<\/summary>/gi);
  if (summaryOpen > 0) s += '</summary>'.repeat(summaryOpen);
  const asideOpen = count(/<aside\b[^>]*>/gi) - count(/<\/aside>/gi);
  if (asideOpen > 0) s += '</aside>'.repeat(asideOpen);
  const detailsOpen = count(/<details\b[^>]*>/gi) - count(/<\/details>/gi);
  if (detailsOpen > 0) s += '\n' + '</details>'.repeat(detailsOpen);
  // Unbalanced spoiler / bold markers render literally — harmless, left as is.
  return s;
}

/** Text that is safe inside an HTML-ish tag in Rich Markdown (e.g. <tg-thinking>). */
export function escapeForTag(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a draft thinking placeholder block. */
export function thinkingBlock(text: string): string {
  const clean = escapeForTag(text.replace(/\s+\n/g, '\n').trim()) || 'Thinking…';
  return `<tg-thinking>${clean}</tg-thinking>`;
}
