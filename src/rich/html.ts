/**
 * Markdown → Telegram HTML (parse_mode=HTML) for the classic fallback path.
 * Telegram HTML has no headings/tables, so: headings → bold, tables → aligned
 * monospace <pre>, <details> → expandable blockquote, lists → bullets.
 */
import { escapeAttr, escapeHtml, plainText } from '../util/text.js';

const PH = (i: number) => `\u0000${i}\u0000`;

function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|tg:\/\/user\?id=|mailto:|tel:)/i.test(u)) return u;
  return null;
}

/** Convert inline Markdown to Telegram HTML. */
export function inlineToHtml(src: string): string {
  const slots: string[] = [];
  const stash = (html: string) => {
    slots.push(html);
    return PH(slots.length - 1);
  };
  let s = src;

  // code spans first
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => stash(`<code>${escapeHtml(c)}</code>`));
  // date-time links (Bot API 9.5 date_time entity)
  s = s.replace(/!\[([^\]\n]*)\]\(tg:\/\/time\?([^)\s]+)\)/gi, (_m, label: string, qs: string) => {
    const params = new URLSearchParams(qs);
    const unixTs = params.get('unix');
    const format = params.get('format');
    if (!unixTs || !/^\d+$/.test(unixTs)) return stash(escapeHtml(label));
    const fmt = format ? ` format="${escapeAttr(format)}"` : '';
    return stash(`<tg-time unix="${unixTs}"${fmt}>${escapeHtml(label || 'time')}</tg-time>`);
  });
  // images → link / alt
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) => {
    const u = safeUrl(url);
    return u ? stash(`<a href="${escapeAttr(u)}">${escapeHtml(alt || 'image')}</a>`) : stash(escapeHtml(alt));
  });
  // links
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) => {
    const u = safeUrl(url);
    const inner = inlineToHtml(text);
    return u ? stash(`<a href="${escapeAttr(u)}">${inner}</a>`) : stash(inner);
  });
  // inline math $…$ (not $$, not prices like "$5 and $10")
  s = s.replace(/(^|[^$\w])\$(?!\s)([^$\n]{1,200}?)(?<!\s)\$(?![\d$])/g, (_m, pre: string, tex: string) => `${pre}${stash(`<code>${escapeHtml(tex)}</code>`)}`);
  // footnote references
  s = s.replace(/\[\^([^\]\s]+)\]/g, (_m, id: string) => stash(`[${escapeHtml(id)}]`));

  s = escapeHtml(s);

  // whitelisted inline HTML the model may use
  s = s.replace(/&lt;(\/?)(u|ins|b|strong|i|em|s|del|code)&gt;/gi, (_m, slash: string, tag: string) => {
    const t = tag.toLowerCase();
    const map: Record<string, string> = { ins: 'u', strong: 'b', em: 'i', del: 's' };
    return `<${slash}${map[t] ?? t}>`;
  });
  s = s.replace(/&lt;\/?(sub|sup|mark|span|br\s*\/?)&gt;/gi, '');

  s = s
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    .replace(/==([^=\n]+?)==/g, '<u>$1</u>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<i>$2</i>');

  // restore stashed fragments (may be nested)
  for (let guard = 0; guard < 5 && s.includes('\u0000'); guard++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
  }
  return s;
}

function renderTable(rows: string[][]): string {
  const cleaned = rows.map((r) => r.map((c) => plainText(c)));
  const cols = Math.max(...cleaned.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.min(24, Math.max(...cleaned.map((r) => Array.from(r[i] ?? '').length))));
  const fmt = (r: string[]) =>
    r
      .concat(Array(cols - r.length).fill(''))
      .map((c, i) => {
        const chars = Array.from(c);
        const w = widths[i] ?? 0;
        const cut = chars.length > w ? chars.slice(0, Math.max(1, w - 1)).join('') + '…' : c;
        return cut + ' '.repeat(Math.max(0, w - Array.from(cut).length));
      })
      .join(' │ ')
      .trimEnd();
  const lines = [fmt(cleaned[0] ?? [])];
  lines.push(widths.map((w) => '─'.repeat(w)).join('─┼─'));
  for (const r of cleaned.slice(1)) lines.push(fmt(r));
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Convert a Markdown document to Telegram HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let quote: string[] | null = null;
  let detailsDepth = 0;

  const flushQuote = () => {
    if (!quote) return;
    const body = quote.join('\n').trim();
    if (body) out.push(`<blockquote${quote.length > 4 ? ' expandable' : ''}>${body}</blockquote>`);
    quote = null;
  };
  const emit = (html: string) => {
    if (detailsDepth > 0) {
      (quote ??= []).push(html);
    } else {
      out.push(html);
    }
  };

  while (i < lines.length) {
    const line = lines[i] as string;

    // fenced code
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) body.push(lines[i++] as string);
      i++;
      const cls = lang && lang !== 'math' ? ` class="language-${escapeAttr(lang)}"` : '';
      if (detailsDepth === 0) flushQuote();
      emit(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    // $$ math block
    if (/^\s*\$\$/.test(line)) {
      const body: string[] = [];
      const first = line.replace(/^\s*\$\$/, '');
      if (first.includes('$$')) {
        emit(`<pre>${escapeHtml(first.replace(/\$\$\s*$/, '').trim())}</pre>`);
        i++;
        continue;
      }
      if (first.trim()) body.push(first);
      i++;
      while (i < lines.length && !(lines[i] as string).includes('$$')) body.push(lines[i++] as string);
      if (i < lines.length) {
        const last = (lines[i] as string).replace(/\$\$.*$/, '');
        if (last.trim()) body.push(last);
        i++;
      }
      emit(`<pre>${escapeHtml(body.join('\n').trim())}</pre>`);
      continue;
    }
    // details / summary / aside
    const det = /^\s*<details(\s+open)?\s*>(.*)$/i.exec(line);
    if (det) {
      if (detailsDepth === 0) flushQuote();
      detailsDepth++;
      quote ??= [];
      const rest = det[2] ?? '';
      if (rest.trim()) lines.splice(i + 1, 0, rest);
      i++;
      continue;
    }
    if (/^\s*<\/details>\s*$/i.test(line)) {
      detailsDepth = Math.max(0, detailsDepth - 1);
      if (detailsDepth === 0) {
        const body = (quote ?? []).join('\n').trim();
        if (body) out.push(`<blockquote expandable>${body}</blockquote>`);
        quote = null;
      }
      i++;
      continue;
    }
    const sum = /^\s*<summary>(.*?)<\/summary>(.*)$/i.exec(line);
    if (sum) {
      emit(`<b>${inlineToHtml(sum[1] ?? '')}</b>`);
      if ((sum[2] ?? '').trim()) emit(inlineToHtml(sum[2] as string));
      i++;
      continue;
    }
    const aside = /^\s*<aside>(.*?)(?:<cite>(.*?)<\/cite>)?\s*<\/aside>\s*$/i.exec(line);
    if (aside) {
      if (detailsDepth === 0) flushQuote();
      const credit = aside[2] ? `\n— <i>${inlineToHtml(aside[2])}</i>` : '';
      emit(`<blockquote>${inlineToHtml(aside[1] ?? '')}${credit}</blockquote>`);
      i++;
      continue;
    }
    // map tag → a link
    const map = /<tg-map\s+lat="([-\d.]+)"\s+long="([-\d.]+)"[^>]*\/?>/i.exec(line);
    if (map) {
      emit(`📍 <a href="https://maps.google.com/?q=${map[1]},${map[2]}">${map[1]}, ${map[2]}</a>`);
      i++;
      continue;
    }
    // tables
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1] as string)) {
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i] as string)) rows.push(splitRow(lines[i++] as string));
      if (detailsDepth === 0) flushQuote();
      emit(renderTable(rows));
      continue;
    }
    // blockquote
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq && detailsDepth === 0) {
      (quote ??= []).push(inlineToHtml(bq[1] ?? ''));
      i++;
      continue;
    }
    if (detailsDepth === 0) flushQuote();
    // headings
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      emit(`<b>${inlineToHtml(h[2] ?? '')}</b>`);
      i++;
      continue;
    }
    // horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      emit('──────────');
      i++;
      continue;
    }
    // footnote definition
    const fn = /^\s*\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (fn) {
      emit(`<i>[${escapeHtml(fn[1] ?? '')}] ${inlineToHtml(fn[2] ?? '')}</i>`);
      i++;
      continue;
    }
    // lists
    const li = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor((li[1] ?? '').replace(/\t/g, '  ').length / 2);
      const indent = '\u00a0\u00a0'.repeat(depth);
      const ordered = /\d/.test(li[2] ?? '');
      const task = li[3];
      const bullet = task ? (/x/i.test(task) ? '☑' : '☐') : ordered ? (li[2] as string).replace(')', '.') : depth > 0 ? '◦' : '•';
      emit(`${indent}${bullet} ${inlineToHtml(li[4] ?? '')}`);
      i++;
      continue;
    }
    emit(line.trim() === '' ? '' : inlineToHtml(line));
    i++;
  }
  flushQuote();
  if (detailsDepth > 0 && quote) out.push(`<blockquote expandable>${(quote as string[]).join('\n')}</blockquote>`);
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
