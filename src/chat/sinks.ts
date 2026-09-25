/**
 * Delivery sinks — how a streaming answer reaches the user in each context.
 *
 *   DraftSink        private chats: sendRichMessageDraft (animated, native ⏹ via can_stop)
 *   MessageEditSink  groups / regenerate-in-place: placeholder + throttled edits (+ ⏹ button)
 *   InlineSink       guest mode (answerGuestQuery → edits) and inline mode (chosen result → edits)
 */
import type { InlineKeyboardMarkup, InlineQueryResult, Message } from 'grammy/types';
import type { App } from '../app.js';
import { logger } from '../log.js';
import { closeForStream, sanitizeModelMarkdown, thinkingBlock } from '../rich/sanitize.js';
import type { EditTarget } from '../rich/render.js';
import { CLASSIC_MAX_CHARS, RICH_MAX_BYTES, charLength, splitMarkdown } from '../rich/split.js';
import { tgDescription } from '../util/tgerrors.js';
import { randomId31, shortId, tail, utf8Bytes } from '../util/text.js';
import type { ActiveGen } from './active.js';

const log = logger('sink');

export interface StreamView {
  content: string;
  reasoning: string;
  status: string;
  startedAt: number;
}

export interface FinalOutput {
  markdown: string;
  keyboard?: InlineKeyboardMarkup;
  effect?: string;
}

export interface Delivered {
  messages: Message[];
  inlineMessageId?: string;
  primaryMessageId?: number;
}

export interface Sink {
  readonly kind: 'draft' | 'message' | 'inline' | 'guest';
  start(status: string): Promise<void>;
  update(view: StreamView): void;
  finalize(out: FinalOutput): Promise<Delivered>;
  fail(text: string): Promise<void>;
  close(): void;
}

/** Runs `fn` at most once per interval, always flushing the latest state. */
export class Pacer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private dirty = false;
  private last = 0;
  private closed = false;
  private extraDelay = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
  ) {}

  poke(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.intervalMs + this.extraDelay - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
    this.timer.unref?.();
  }

  delay(ms: number): void {
    this.extraDelay = Math.max(this.extraDelay, ms);
  }

  private run(): void {
    if (this.closed || !this.dirty) return;
    this.dirty = false;
    this.running = this.running
      .then(async () => {
        this.last = Date.now();
        await this.fn();
        this.extraDelay = 0;
      })
      .catch((err) => log.debug(`pacer: ${(err as Error)?.message ?? err}`))
      .finally(() => {
        this.last = Date.now();
        if (this.dirty && !this.closed) this.poke();
      });
  }

  /** Stop scheduling and wait for the in-flight call. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}

function elapsed(view: StreamView): number {
  return Math.max(1, Math.round((Date.now() - view.startedAt) / 1000));
}

/** Streaming markdown for drafts (thinking block allowed). */
export function draftMarkdown(view: StreamView, maxBytes = RICH_MAX_BYTES - 2000): string {
  if (view.content.trim()) {
    let body = closeForStream(sanitizeModelMarkdown(view.content));
    if (utf8Bytes(body) > maxBytes) {
      const parts = splitMarkdown(body, maxBytes);
      body = closeForStream(parts[parts.length - 1] as string);
    }
    return body || thinkingBlock(view.status);
  }
  if (view.reasoning.trim()) return thinkingBlock(`${view.status} (${elapsed(view)}s)\n${tail(view.reasoning.trim(), 700)}`);
  return thinkingBlock(view.status);
}

/** Streaming markdown for message edits (no thinking blocks outside drafts). */
export function editMarkdownFor(view: StreamView, maxBytes: number): string {
  if (view.content.trim()) {
    let body = closeForStream(sanitizeModelMarkdown(view.content));
    if (utf8Bytes(body) > maxBytes) body = closeForStream(splitMarkdown(body, maxBytes)[0] as string);
    return `${body} ▍`;
  }
  const status = `_💭 ${view.status.replace(/[_*]/g, '')}_`;
  if (view.reasoning.trim()) {
    const r = tail(view.reasoning.trim(), 280).replace(/\n+/g, ' ').replace(/[<>|*_`]/g, '');
    return `${status}\n\n> ${r}`;
  }
  return status;
}

export function stopKeyboard(token: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '⏹ Stop', callback_data: `stop:${token}` }]] };
}

// ---------------------------------------------------------------- private: drafts

export class DraftSink implements Sink {
  readonly kind = 'draft' as const;
  readonly draftId = randomId31();
  private view: StreamView = { content: '', reasoning: '', status: '', startedAt: Date.now() };
  private pacer: Pacer;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private lastPayload = '';
  private fallback: MessageEditSink | null = null;
  private closed = false;

  constructor(
    private readonly app: App,
    private readonly chatId: number,
    private readonly opts: { threadId?: number; classic: boolean; gen: ActiveGen },
  ) {
    this.pacer = new Pacer(app.cfg.streamIntervalMs, async () => {
      await this.push();
    });
  }

  async start(status: string): Promise<void> {
    this.app.active.bindDraft(this.opts.gen, this.chatId, this.draftId);
    this.view = { content: '', reasoning: '', status, startedAt: Date.now() };
    void this.app.api.sendChatAction(this.chatId, 'typing', { message_thread_id: this.opts.threadId }).catch(() => undefined);
    const ok = await this.push(true);
    if (!ok && this.app.renderer.draftsUnsupported) {
      this.fallback = new MessageEditSink(this.app, this.chatId, { threadId: this.opts.threadId, classic: this.opts.classic, isPrivate: true, stopToken: this.opts.gen.token });
      await this.fallback.start(status);
      return;
    }
    // Drafts vanish after ~30 s without updates — keep the preview alive during long thinking.
    this.keepAlive = setInterval(() => {
      if (!this.closed && Date.now() - this.lastSentAt > 18_000) void this.push(true);
    }, 4_000);
    this.keepAlive.unref?.();
  }

  update(view: StreamView): void {
    this.view = view;
    if (this.fallback) this.fallback.update(view);
    else this.pacer.poke();
  }

  private async push(force = false): Promise<boolean> {
    if (this.closed) return true;
    const md = draftMarkdown(this.view);
    if (!force && md === this.lastPayload) return true;
    this.lastPayload = md;
    this.lastSentAt = Date.now();
    return this.app.renderer.draft(this.chatId, this.draftId, md, { threadId: this.opts.threadId, canStop: true, classic: this.opts.classic });
  }

  private async stopStreaming(): Promise<void> {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    await this.pacer.close();
  }

  async finalize(out: FinalOutput): Promise<Delivered> {
    await this.stopStreaming();
    if (this.fallback) return this.fallback.finalize(out);
    const messages = await this.app.renderer.sendMarkdown(this.chatId, out.markdown, {
      threadId: this.opts.threadId,
      keyboard: out.keyboard,
      effect: out.effect,
      isPrivate: true,
      classic: this.opts.classic,
    });
    return { messages, primaryMessageId: messages[messages.length - 1]?.message_id };
  }

  async fail(text: string): Promise<void> {
    await this.stopStreaming();
    if (this.fallback) return this.fallback.fail(text);
    await this.app.api.sendMessage(this.chatId, text, { message_thread_id: this.opts.threadId }).catch((err) => log.warn(`fail message: ${tgDescription(err)}`));
  }

  close(): void {
    void this.stopStreaming();
    this.fallback?.close();
  }
}

// ---------------------------------------------------------------- groups / in-place edits

export class MessageEditSink implements Sink {
  readonly kind = 'message' as const;
  private target: EditTarget | null = null;
  private view: StreamView = { content: '', reasoning: '', status: '', startedAt: Date.now() };
  private pacer: Pacer;
  private closed = false;
  private placeholder: Message | null = null;

  constructor(
    private readonly app: App,
    private readonly chatId: number,
    private readonly opts: {
      threadId?: number;
      replyTo?: number;
      classic: boolean;
      isPrivate: boolean;
      stopToken?: string;
      existingMessageId?: number;
    },
  ) {
    this.pacer = new Pacer(opts.isPrivate ? Math.max(1000, app.cfg.editIntervalMs - 400) : app.cfg.editIntervalMs, () => this.push());
  }

  private get stopKb(): InlineKeyboardMarkup | undefined {
    return this.opts.stopToken ? stopKeyboard(this.opts.stopToken) : undefined;
  }

  private get maxBytes(): number {
    return this.app.renderer.useRich(this.opts.classic) ? RICH_MAX_BYTES : CLASSIC_MAX_CHARS;
  }

  async start(status: string): Promise<void> {
    this.view = { content: '', reasoning: '', status, startedAt: Date.now() };
    void this.app.api.sendChatAction(this.chatId, 'typing', { message_thread_id: this.opts.threadId }).catch(() => undefined);
    if (this.opts.existingMessageId) {
      this.target = { kind: 'message', chatId: this.chatId, messageId: this.opts.existingMessageId };
      await this.app.renderer.editMarkdown(this.target, editMarkdownFor(this.view, this.maxBytes), { keyboard: this.stopKb, classic: this.opts.classic });
      return;
    }
    const [msg] = await this.app.renderer.sendMarkdown(this.chatId, editMarkdownFor(this.view, this.maxBytes), {
      threadId: this.opts.threadId,
      replyTo: this.opts.replyTo,
      keyboard: this.stopKb,
      classic: this.opts.classic,
      isPrivate: this.opts.isPrivate,
    });
    if (msg) {
      this.placeholder = msg;
      this.target = { kind: 'message', chatId: this.chatId, messageId: msg.message_id };
    }
  }

  update(view: StreamView): void {
    this.view = view;
    this.pacer.poke();
  }

  private async push(): Promise<void> {
    if (this.closed || !this.target) return;
    const wait = this.app.renderer.cooldownLeft(this.target);
    if (wait > 0) {
      this.pacer.delay(wait);
      this.pacer.poke();
      return;
    }
    const r = await this.app.renderer.editMarkdown(this.target, editMarkdownFor(this.view, this.maxBytes), { keyboard: this.stopKb, classic: this.opts.classic });
    if (r === 'rate_limited') this.pacer.delay(this.app.renderer.cooldownLeft(this.target));
  }

  async finalize(out: FinalOutput): Promise<Delivered> {
    this.closed = true;
    await this.pacer.close();
    const rich = this.app.renderer.useRich(this.opts.classic);
    const parts = rich ? splitMarkdown(out.markdown, RICH_MAX_BYTES) : splitMarkdown(out.markdown, CLASSIC_MAX_CHARS, charLength);
    if (!this.target) {
      const messages = await this.app.renderer.sendMarkdown(this.chatId, out.markdown, {
        threadId: this.opts.threadId,
        replyTo: this.opts.replyTo,
        keyboard: out.keyboard,
        classic: this.opts.classic,
        isPrivate: this.opts.isPrivate,
      });
      return { messages, primaryMessageId: messages[messages.length - 1]?.message_id };
    }
    const single = parts.length === 1;
    const wait = this.app.renderer.cooldownLeft(this.target);
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
    const res = await this.app.renderer.editMarkdown(this.target, parts[0] as string, { keyboard: single ? out.keyboard : undefined, classic: this.opts.classic });
    const messages: Message[] = this.placeholder ? [this.placeholder] : [];
    if (res === 'failed' || res === 'rate_limited') {
      // Could not finish the placeholder — deliver as a fresh message instead.
      const fresh = await this.app.renderer.sendMarkdown(this.chatId, out.markdown, {
        threadId: this.opts.threadId,
        replyTo: this.opts.replyTo,
        keyboard: out.keyboard,
        classic: this.opts.classic,
        isPrivate: this.opts.isPrivate,
      });
      if (this.target.kind === 'message') await this.app.api.deleteMessage(this.chatId, this.target.messageId).catch(() => undefined);
      return { messages: fresh, primaryMessageId: fresh[fresh.length - 1]?.message_id };
    }
    if (single) return { messages, primaryMessageId: this.target.kind === 'message' ? this.target.messageId : undefined };
    const rest = await this.app.renderer.sendMarkdown(this.chatId, parts.slice(1).join('\n\n'), {
      threadId: this.opts.threadId,
      keyboard: out.keyboard,
      classic: this.opts.classic,
      isPrivate: this.opts.isPrivate,
    });
    return { messages: [...messages, ...rest], primaryMessageId: rest[rest.length - 1]?.message_id };
  }

  async fail(text: string): Promise<void> {
    this.closed = true;
    await this.pacer.close();
    if (this.target) await this.app.renderer.editMarkdown(this.target, text, { classic: this.opts.classic });
    else await this.app.api.sendMessage(this.chatId, text, { message_thread_id: this.opts.threadId }).catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    void this.pacer.close();
  }
}

// ---------------------------------------------------------------- guest mode & inline mode

export class InlineSink implements Sink {
  readonly kind: 'inline' | 'guest';
  private inlineMessageId: string | undefined;
  private view: StreamView = { content: '', reasoning: '', status: '', startedAt: Date.now() };
  private pacer: Pacer;
  private closed = false;

  constructor(
    private readonly app: App,
    private readonly opts: { inlineMessageId?: string; guestQueryId?: string; classic: boolean; footer?: InlineKeyboardMarkup },
  ) {
    this.kind = opts.guestQueryId ? 'guest' : 'inline';
    this.inlineMessageId = opts.inlineMessageId;
    this.pacer = new Pacer(Math.max(1500, app.cfg.editIntervalMs), () => this.push());
  }

  private get target(): EditTarget | null {
    return this.inlineMessageId ? { kind: 'inline', inlineMessageId: this.inlineMessageId } : null;
  }

  private maxSingle(): number {
    return this.app.renderer.useRich(this.opts.classic) ? RICH_MAX_BYTES : 3900;
  }

  async start(status: string): Promise<void> {
    this.view = { content: '', reasoning: '', status, startedAt: Date.now() };
    if (this.opts.guestQueryId) {
      const placeholder = `_💭 ${status.replace(/[_*]/g, '')}_`;
      const result: InlineQueryResult = {
        type: 'article',
        id: shortId(),
        title: 'Alya',
        input_message_content: this.app.renderer.useRich(this.opts.classic)
          ? { rich_message: { markdown: placeholder } }
          : { message_text: `💭 ${status}` },
        reply_markup: this.opts.footer,
      };
      const sent = await this.app.api.answerGuestQuery(this.opts.guestQueryId, result);
      this.inlineMessageId = sent.inline_message_id;
      if (!this.inlineMessageId) log.warn('answerGuestQuery returned no inline_message_id — cannot stream edits');
    }
  }

  update(view: StreamView): void {
    this.view = view;
    this.pacer.poke();
  }

  private async push(): Promise<void> {
    const target = this.target;
    if (this.closed || !target) return;
    const wait = this.app.renderer.cooldownLeft(target);
    if (wait > 0) {
      this.pacer.delay(wait);
      this.pacer.poke();
      return;
    }
    await this.app.renderer.editMarkdown(target, editMarkdownFor(this.view, this.maxSingle()), { keyboard: this.opts.footer, classic: this.opts.classic });
  }

  async finalize(out: FinalOutput): Promise<Delivered> {
    this.closed = true;
    await this.pacer.close();
    const target = this.target;
    if (target) {
      const wait = this.app.renderer.cooldownLeft(target);
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
      const md = splitMarkdown(out.markdown, this.maxSingle(), this.app.renderer.useRich(this.opts.classic) ? utf8Bytes : charLength)[0] as string;
      await this.app.renderer.editMarkdown(target, md, { keyboard: out.keyboard ?? this.opts.footer, classic: this.opts.classic });
    }
    return { messages: [], inlineMessageId: this.inlineMessageId };
  }

  async fail(text: string): Promise<void> {
    this.closed = true;
    await this.pacer.close();
    const target = this.target;
    if (target) await this.app.renderer.editMarkdown(target, text, { keyboard: this.opts.footer, classic: this.opts.classic });
  }

  close(): void {
    this.closed = true;
    void this.pacer.close();
  }
}
