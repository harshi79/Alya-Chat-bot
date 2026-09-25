/**
 * Typed builders for outgoing rich blocks (Bot API 10.2+ `InputRichMessage.blocks`)
 * plus an HTML renderer so every UI screen also works on the classic path.
 */
import type {
  InlineKeyboardMarkup,
  InputRichBlock,
  RichBlockTableCell,
  RichMessageButton,
  RichText,
} from 'grammy/types';
import { escapeAttr, escapeHtml } from '../util/text.js';

export type Block = InputRichBlock;
export type Cell = RichBlockTableCell;
type Align = 'left' | 'center' | 'right';

// ------------------------------------------------------------ inline rich text

export const b = (text: RichText): RichText => ({ type: 'bold', text });
export const i = (text: RichText): RichText => ({ type: 'italic', text });
export const u = (text: RichText): RichText => ({ type: 'underline', text });
export const s = (text: RichText): RichText => ({ type: 'strikethrough', text });
export const code = (text: string): RichText => ({ type: 'code', text });
export const mark = (text: RichText): RichText => ({ type: 'marked', text });
export const spoiler = (text: RichText): RichText => ({ type: 'spoiler', text });
export const sub = (text: RichText): RichText => ({ type: 'subscript', text });
export const sup = (text: RichText): RichText => ({ type: 'superscript', text });
export const link = (text: RichText, url: string): RichText => ({ type: 'url', text, url });
export const math = (expression: string): RichText => ({ type: 'mathematical_expression', expression });
/** Bot API 9.5 date_time: rendered in each reader's own timezone. */
export const time = (unix: number, format: 'r' | 'wDT' | 'DT' | 'dt' | 't' | 'D' | 'd' | 'T' | 'wD' | 'Dt' | 'dT', text: string): RichText => ({
  type: 'date_time',
  text,
  unix_time: unix,
  date_time_format: format,
});
export const t = (...parts: RichText[]): RichText => (parts.length === 1 ? (parts[0] as RichText) : parts);

// ------------------------------------------------------------ blocks

export const h = (size: 1 | 2 | 3 | 4 | 5 | 6, text: RichText): Block => ({ type: 'heading', size, text });
export const p = (...parts: RichText[]): Block => ({ type: 'paragraph', text: t(...parts) });
export const pre = (text: string, language?: string): Block => (language ? { type: 'pre', text, language } : { type: 'pre', text });
export const footer = (...parts: RichText[]): Block => ({ type: 'footer', text: t(...parts) });
export const divider = (): Block => ({ type: 'divider' });
export const mathBlock = (expression: string): Block => ({ type: 'mathematical_expression', expression });
export const quote = (blocks: Block[], credit?: RichText): Block => (credit === undefined ? { type: 'blockquote', blocks } : { type: 'blockquote', blocks, credit });
export const expandable = (text: RichText, credit?: RichText): Block =>
  credit === undefined ? { type: 'expandable_blockquote', text } : { type: 'expandable_blockquote', text, credit };
export const pullquote = (text: RichText, credit?: RichText): Block => (credit === undefined ? { type: 'pullquote', text } : { type: 'pullquote', text, credit });
export const details = (summary: RichText, blocks: Block[], open = false): Block =>
  open ? { type: 'details', summary, blocks, is_open: true } : { type: 'details', summary, blocks };
export const thinking = (text: RichText): Block => ({ type: 'thinking', text });
export const map = (latitude: number, longitude: number, zoom = 13, caption?: RichText): Block => ({
  type: 'map',
  location: { latitude, longitude },
  zoom,
  width: 600,
  height: 300,
  ...(caption === undefined ? {} : { caption: { text: caption } }),
});

export function list(items: Array<RichText | Block[]>, opts: { ordered?: boolean; checks?: boolean[] } = {}): Block {
  return {
    type: 'list',
    items: items.map((item, idx) => {
      const blocks: Block[] = Array.isArray(item) && item.length > 0 && typeof item[0] === 'object' && item[0] !== null && 'type' in (item[0] as object) && isBlockType((item[0] as { type: string }).type)
        ? (item as Block[])
        : [p(item as RichText)];
      const out: { blocks: Block[]; type?: '1'; has_checkbox?: true; is_checked?: true } = { blocks };
      if (opts.ordered) out.type = '1';
      const check = opts.checks?.[idx];
      if (check !== undefined) {
        out.has_checkbox = true;
        if (check) out.is_checked = true;
      }
      return out;
    }),
  };
}

const BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'pre', 'footer', 'divider', 'mathematical_expression', 'anchor', 'list', 'blockquote',
  'expandable_blockquote', 'pullquote', 'collage', 'slideshow', 'table', 'details', 'map', 'animation', 'audio',
  'document', 'photo', 'video', 'voice_note', 'buttons', 'thinking',
]);
function isBlockType(t: string): boolean {
  return BLOCK_TYPES.has(t);
}

export function cell(text: RichText, opts: { header?: boolean; align?: Align; valign?: 'top' | 'middle' | 'bottom'; colspan?: number } = {}): Cell {
  const c: Cell = { text, align: opts.align ?? (opts.header ? 'center' : 'left'), valign: opts.valign ?? 'middle' };
  if (opts.header) c.is_header = true;
  if (opts.colspan && opts.colspan > 1) c.colspan = opts.colspan;
  return c;
}

/** Table from a header row + body rows. Numbers are right-aligned automatically. */
export function table(
  header: RichText[] | null,
  rows: RichText[][],
  opts: { compact?: boolean; striped?: boolean; bordered?: boolean; caption?: RichText; align?: Align[] } = {},
): Block {
  const alignFor = (col: number, v: RichText): Align => opts.align?.[col] ?? (typeof v === 'string' && /^[-+]?[\d.,\s%/]+$/.test(v.trim()) ? 'right' : 'left');
  const cells: Cell[][] = [];
  if (header) cells.push(header.map((hd, col) => cell(hd, { header: true, align: opts.align?.[col] ?? 'center' })));
  for (const r of rows) cells.push(r.map((v, col) => cell(v, { align: alignFor(col, v) })));
  const blk: Block = { type: 'table', cells };
  if (opts.compact) blk.is_compact = true;
  if (opts.striped) blk.is_striped = true;
  if (opts.bordered) blk.is_bordered = true;
  if (opts.caption !== undefined) blk.caption = opts.caption;
  return blk;
}

// ------------------------------------------------------------ buttons (10.3)

export type Style = 'primary' | 'success' | 'danger';

export function rbtn(text: string, data: string, style?: Style | 'link'): RichMessageButton {
  return style ? { text, callback_data: data, style } : { text, callback_data: data };
}
export function rurl(text: string, url: string, style?: Style): RichMessageButton {
  return style ? { text, url, style } : { text, url };
}
export function rcopy(text: string, copied: string): RichMessageButton {
  return { text, copy_text: { text: copied.slice(0, 256) } };
}
export const buttons = (btns: RichMessageButton[], align: Align = 'center'): Block => ({ type: 'buttons', buttons: btns, align });

// ------------------------------------------------------------ screens

export interface Screen {
  blocks: Block[];
  keyboard?: InlineKeyboardMarkup;
  /** Message effect (private chats only). */
  effect?: string;
}

// ------------------------------------------------------------ HTML fallback renderer

export function richTextToHtml(rt: RichText | undefined): string {
  if (rt === undefined || rt === null) return '';
  if (typeof rt === 'string') return escapeHtml(rt);
  if (Array.isArray(rt)) return rt.map((x) => richTextToHtml(x)).join('');
  const r = rt as { type: string; text?: RichText; url?: string; expression?: string; unix_time?: number; date_time_format?: string; button?: RichMessageButton; phone_number?: string; email_address?: string };
  const inner = richTextToHtml(r.text);
  switch (r.type) {
    case 'bold':
      return `<b>${inner}</b>`;
    case 'italic':
      return `<i>${inner}</i>`;
    case 'underline':
    case 'marked':
      return `<u>${inner}</u>`;
    case 'strikethrough':
      return `<s>${inner}</s>`;
    case 'spoiler':
      return `<tg-spoiler>${inner}</tg-spoiler>`;
    case 'code':
      return `<code>${inner}</code>`;
    case 'url':
      return `<a href="${escapeAttr(r.url ?? '')}">${inner}</a>`;
    case 'mathematical_expression':
      return `<code>${escapeHtml(r.expression ?? '')}</code>`;
    case 'date_time':
      return `<tg-time unix="${r.unix_time ?? 0}" format="${escapeAttr(r.date_time_format ?? 'wDT')}">${inner}</tg-time>`;
    case 'button':
      return '';
    default:
      return inner;
  }
}

export function blocksToHtml(blocks: Block[], depth = 0): string {
  const out: string[] = [];
  for (const blk of blocks) {
    switch (blk.type) {
      case 'heading':
        out.push(`<b>${richTextToHtml(blk.text)}</b>`);
        break;
      case 'paragraph':
        out.push(richTextToHtml(blk.text));
        break;
      case 'pre':
        out.push(`<pre>${richTextToHtml(blk.text)}</pre>`);
        break;
      case 'footer':
        out.push(`<i>${richTextToHtml(blk.text)}</i>`);
        break;
      case 'divider':
        out.push('──────────');
        break;
      case 'mathematical_expression':
        out.push(`<code>${escapeHtml(blk.expression)}</code>`);
        break;
      case 'list':
        blk.items.forEach((it, idx) => {
          const mark = it.has_checkbox ? (it.is_checked ? '☑' : '☐') : it.type ? `${idx + 1}.` : '•';
          out.push(`${'\u00a0\u00a0'.repeat(depth)}${mark} ${blocksToHtml(it.blocks, depth + 1)}`);
        });
        break;
      case 'blockquote':
        out.push(`<blockquote>${blocksToHtml(blk.blocks, depth)}${blk.credit ? `\n— ${richTextToHtml(blk.credit)}` : ''}</blockquote>`);
        break;
      case 'expandable_blockquote':
        out.push(`<blockquote expandable>${richTextToHtml(blk.text)}${blk.credit ? `\n— ${richTextToHtml(blk.credit)}` : ''}</blockquote>`);
        break;
      case 'pullquote':
        out.push(`<blockquote><i>${richTextToHtml(blk.text)}</i>${blk.credit ? `\n— ${richTextToHtml(blk.credit)}` : ''}</blockquote>`);
        break;
      case 'details':
        out.push(`<blockquote expandable><b>${richTextToHtml(blk.summary)}</b>\n${blocksToHtml(blk.blocks, depth)}</blockquote>`);
        break;
      case 'table': {
        const rows = blk.cells.map((r) => r.map((c) => plainRich(c.text)));
        const cols = Math.max(...rows.map((r) => r.length));
        const widths = Array.from({ length: cols }, (_, ci) => Math.min(22, Math.max(...rows.map((r) => Array.from(r[ci] ?? '').length))));
        const lines = rows.map((r) =>
          r
            .map((c, ci) => c + ' '.repeat(Math.max(0, (widths[ci] ?? 0) - Array.from(c).length)))
            .join('  ')
            .trimEnd(),
        );
        out.push(`<pre>${escapeHtml(lines.join('\n'))}</pre>`);
        break;
      }
      case 'map':
        out.push(`📍 <a href="https://maps.google.com/?q=${blk.location.latitude},${blk.location.longitude}">${blk.caption ? richTextToHtml(blk.caption.text) : 'Map'}</a>`);
        break;
      case 'thinking':
        out.push(`<i>${richTextToHtml(blk.text)}</i>`);
        break;
      case 'buttons':
        break; // rendered as the inline keyboard on the classic path
      default:
        break;
    }
  }
  return out.filter((x) => x !== '').join('\n\n');
}

/** Plain text of a RichText value (for tables in monospace, previews). */
export function plainRich(rt: RichText | undefined): string {
  if (rt === undefined || rt === null) return '';
  if (typeof rt === 'string') return rt;
  if (Array.isArray(rt)) return rt.map((x) => plainRich(x)).join('');
  const r = rt as { text?: RichText; expression?: string };
  if (r.expression) return r.expression;
  return plainRich(r.text);
}

/** Collect in-message rich buttons into an inline keyboard (classic path). */
export function buttonsToKeyboard(blocks: Block[]): InlineKeyboardMarkup['inline_keyboard'] {
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
  for (const blk of blocks) {
    if (blk.type !== 'buttons') continue;
    const row = blk.buttons
      .map((btn) => {
        const text = plainRich(btn.text);
        if ('callback_data' in btn) return { text, callback_data: btn.callback_data };
        if ('url' in btn) return { text, url: btn.url };
        if ('copy_text' in btn) return { text, copy_text: btn.copy_text };
        if ('switch_inline_query_chosen_chat' in btn) return { text, switch_inline_query_chosen_chat: btn.switch_inline_query_chosen_chat };
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (row.length) rows.push(row);
  }
  return rows;
}
