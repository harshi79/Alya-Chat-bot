import { describe, expect, it } from 'vitest';
import { blocksToHtml, buttons, details, h, p, rbtn, table, time } from '../src/rich/blocks.js';
import { markdownToHtml, inlineToHtml } from '../src/rich/html.js';
import { closeForStream, sanitizeModelMarkdown, thinkingBlock } from '../src/rich/sanitize.js';
import { charLength, splitMarkdown } from '../src/rich/split.js';
import { utf8Bytes } from '../src/util/text.js';

describe('sanitizeModelMarkdown', () => {
  it('strips interactive tags, including nested pairs that would re-assemble', () => {
    const evil = 'Hi <tg-<tg-button>button type="callback_data" data="pay">Buy</tg-button> there <tg-button-row><tg-button type="url" url="x">x</tg-button></tg-button-row>';
    const out = sanitizeModelMarkdown(evil);
    expect(out).not.toMatch(/<\s*\/?\s*tg-button/i);
    expect(out).toContain('Hi');
  });

  it('strips a start tag without whitespace and media references', () => {
    const out = sanitizeModelMarkdown('a <tg-buttonx>b</tg-button> [doc](tg://document?id=abc) ![](tg://photo?id=p1) c');
    expect(out).not.toMatch(/tg-button\b/);
    expect(out).not.toContain('tg://document');
    expect(out).not.toContain('tg://photo');
  });

  it('keeps date-time links, drops custom emoji, turns remote images into links', () => {
    const out = sanitizeModelMarkdown('At ![22:45](tg://time?unix=1647531900&format=wDT) ![👍](tg://emoji?id=5368324170671202286) ![cat](https://x.test/cat.jpg)');
    expect(out).toContain('![22:45](tg://time?unix=1647531900&format=wDT)');
    expect(out).toContain('👍');
    expect(out).not.toContain('tg://emoji');
    expect(out).toContain('[cat](https://x.test/cat.jpg)');
  });

  it('removes leaked tool calls and think blocks, including an unclosed trailing tool call', () => {
    expect(sanitizeModelMarkdown('ok <tool_call>{"name":"x"}</tool_call> done')).toBe('ok  done');
    expect(sanitizeModelMarkdown('<think>secret</think>Hello')).toBe('Hello');
    expect(sanitizeModelMarkdown('Answer <tool_call>{"name":"remember_fact","argu')).toBe('Answer');
  });
});

describe('sanitizeModelMarkdown keeps code intact', () => {
  it('does not touch HTML inside fenced code blocks or inline code', () => {
    const md = 'Here is a form:\n\n```html\n<form action="/x"><input name="q"><button>Go</button><img src="a.png"></form>\n```\n\nUse `<tg-button>` carefully. <tg-button>fake</tg-button>';
    const out = sanitizeModelMarkdown(md);
    expect(out).toContain('<form action="/x"><input name="q"><button>Go</button><img src="a.png"></form>');
    expect(out).toContain('`<tg-button>`');
    expect(out).toMatch(/carefully\. fake$/);
  });
  it('allows harmless Telegram tags and strips every other tg-* tag', () => {
    const out = sanitizeModelMarkdown('<tg-spoiler>s</tg-spoiler> <tg-map lat="1" long="2" zoom="13"/> <tg-document id="x">d</tg-document> <tg-button"x">b</tg-button>');
    expect(out).toContain('<tg-spoiler>s</tg-spoiler>');
    expect(out).toContain('<tg-map lat="1" long="2" zoom="13"/>');
    expect(out).not.toContain('tg-document');
    expect(out).not.toMatch(/<tg-button/);
  });
  it('does not eat prose with comparison signs', () => {
    expect(sanitizeModelMarkdown('if a <input then b > c')).toBe('if a <input then b > c'.replace('<input then b >', ''));
    expect(sanitizeModelMarkdown('x < y and y > z')).toBe('x < y and y > z');
    expect(sanitizeModelMarkdown('the <img tag\nnext line')).toBe('the <img tag\nnext line');
  });
});

describe('closeForStream', () => {
  it('closes an open code fence', () => {
    expect(closeForStream('```python\nprint(1)')).toBe('```python\nprint(1)\n```');
  });
  it('closes $$ and details/summary, and drops a dangling tag', () => {
    const out = closeForStream('text $$x^2 <details><summary>Why');
    expect(out.match(/\$\$/g)?.length).toBe(2);
    expect(out).toContain('</summary>');
    expect(out).toContain('</details>');
    expect(closeForStream('hello <deta')).toBe('hello ');
  });
  it('drops a half-written link url', () => {
    expect(closeForStream('see [docs](https://exa')).toBe('see [docs]');
  });
  it('leaves balanced content untouched', () => {
    const md = '# Title\n\n```js\nx\n```\n\n$$a$$';
    expect(closeForStream(md)).toBe(md);
  });
});

describe('thinkingBlock', () => {
  it('escapes markup inside the thinking tag', () => {
    expect(thinkingBlock('a <b> & c')).toBe('<tg-thinking>a &lt;b&gt; &amp; c</tg-thinking>');
  });
});

describe('markdownToHtml (classic fallback)', () => {
  it('converts inline formatting and escapes HTML', () => {
    expect(inlineToHtml('**bold** *it* ~~s~~ ||spoiler|| `a<b>` <script>')).toBe('<b>bold</b> <i>it</i> <s>s</s> <tg-spoiler>spoiler</tg-spoiler> <code>a&lt;b&gt;</code> &lt;script&gt;');
  });
  it('renders headings, lists, tasks, code blocks and links', () => {
    const html = markdownToHtml('# Plan\n- one\n- [x] done\n1. first\n```ts\nconst a = 1 < 2;\n```\n[site](https://example.com)');
    expect(html).toContain('<b>Plan</b>');
    expect(html).toContain('• one');
    expect(html).toContain('☑ done');
    expect(html).toContain('1. first');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<a href="https://example.com">site</a>');
  });
  it('renders tables as aligned monospace and details as expandable quotes', () => {
    const html = markdownToHtml('| Name | Score |\n|---|---:|\n| Alya | 100 |\n\n<details><summary>More</summary>\nhidden\n</details>');
    expect(html).toMatch(/<pre>Name\s+│ Score/);
    expect(html).toContain('<blockquote expandable><b>More</b>');
    expect(html).toContain('hidden');
  });
  it('converts date-time links to tg-time and refuses javascript links', () => {
    expect(inlineToHtml('![soon](tg://time?unix=100&format=r)')).toBe('<tg-time unix="100" format="r">soon</tg-time>');
    expect(inlineToHtml('[x](javascript:alert(1))')).not.toContain('href');
  });
  it('does not treat prices as math', () => {
    expect(inlineToHtml('costs $5 and $10 today')).toBe('costs $5 and $10 today');
    expect(inlineToHtml('area is $x^2$ now')).toBe('area is <code>x^2</code> now');
  });
});

describe('splitMarkdown', () => {
  it('never splits inside a code fence and respects the limit', () => {
    const code = '```py\n' + Array.from({ length: 200 }, (_, i) => `print(${i})`).join('\n') + '\n```';
    const md = `Intro paragraph.\n\n${code}\n\nOutro.`;
    const parts = splitMarkdown(md, 800, charLength);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(800);
      const fences = (part.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });
  it('measures UTF-8 bytes for Cyrillic', () => {
    const md = 'Привет мир. '.repeat(400);
    const parts = splitMarkdown(md, 2000);
    for (const part of parts) expect(utf8Bytes(part)).toBeLessThanOrEqual(2000);
  });
});

describe('blocks → HTML fallback', () => {
  it('renders a screen with a table, details and in-message buttons dropped', () => {
    const html = blocksToHtml([
      h(2, 'Hello'),
      p('Text ', { type: 'bold', text: 'bold' }),
      table(['A', 'B'], [['1', '2']], { compact: true }),
      details('More', [p('inside')]),
      buttons([rbtn('Go', 'go')]),
      p(time(1700000000, 'wDT', 'fallback')),
    ]);
    expect(html).toContain('<b>Hello</b>');
    expect(html).toContain('Text <b>bold</b>');
    expect(html).toContain('<pre>');
    expect(html).toContain('<blockquote expandable><b>More</b>');
    expect(html).toContain('<tg-time unix="1700000000" format="wDT">fallback</tg-time>');
    expect(html).not.toContain('Go');
  });
});
