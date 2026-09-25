/**
 * Renderer — the one place that talks to Telegram for rich content.
 *
 * Rich first (Bot API 10.1+). On a *definite* rejection (400/404/406) it falls
 * back to classic HTML; if the server doesn't know rich methods at all (old
 * self-hosted server), that is remembered for the whole process. Unknown
 * outcomes (timeouts, 5xx) are re-thrown — never blindly resent.
 */
import type { Api } from 'grammy';
import type { EphemeralMessageParameters, InlineKeyboardMarkup, Message, ReplyParameters } from 'grammy/types';
import { logger } from '../log.js';
import {
  isDefinitiveRejection,
  isEffectInvalid,
  isNotModified,
  isRateLimited,
  isReplyNotFound,
  isThreadNotFound,
  isUnknownMethod,
  retryAfterSec,
  tgDescription,
} from '../util/tgerrors.js';
import { blocksToHtml, buttonsToKeyboard, type Screen } from './blocks.js';
import { markdownToHtml } from './html.js';
import { CLASSIC_MAX_CHARS, RICH_MAX_BYTES, charLength, splitMarkdown } from './split.js';

const log = logger('render');

export interface SendOpts {
  threadId?: number;
  replyTo?: number;
  replyToEphemeral?: number;
  keyboard?: InlineKeyboardMarkup;
  effect?: string;
  ephemeral?: EphemeralMessageParameters;
  classic?: boolean;
  silent?: boolean;
  isPrivate?: boolean;
}

export type EditTarget =
  | { kind: 'message'; chatId: number; messageId: number }
  | { kind: 'inline'; inlineMessageId: string }
  | { kind: 'ephemeral'; chatId: number; receiverUserId: number; ephemeralMessageId: number };

export type EditResult = 'ok' | 'unchanged' | 'rate_limited' | 'failed';

/** Visible-length cap for a single classic message (inline/guest edits can't be split). */
const CLASSIC_SINGLE_MAX = 4000;

export class Renderer {
  richUnsupported = false;
  draftsUnsupported = false;
  richDraftsUnsupported = false;
  private badEffects = new Set<string>();
  /** Last seen retry_after per chat for edit pacing. */
  readonly cooldowns = new Map<string, number>();

  constructor(readonly api: Api) {}

  useRich(classicPref?: boolean): boolean {
    return !classicPref && !this.richUnsupported;
  }

  private replyParams(opts: SendOpts): ReplyParameters | undefined {
    if (opts.replyToEphemeral) return { ephemeral_message_id: opts.replyToEphemeral };
    if (opts.replyTo) return { message_id: opts.replyTo, allow_sending_without_reply: true };
    return undefined;
  }

  private effectFor(opts: SendOpts): string | undefined {
    if (!opts.effect || !opts.isPrivate || opts.ephemeral) return undefined;
    return this.badEffects.has(opts.effect) ? undefined : opts.effect;
  }

  /**
   * Run a send with automatic "soft" repairs: bad effect → drop effect,
   * missing reply target → drop reply, missing topic → drop thread.
   */
  private async withRepairs<T>(fn: (o: SendOpts) => Promise<T>, opts: SendOpts): Promise<T> {
    let o: SendOpts = { ...opts };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn(o);
      } catch (err) {
        if (o.effect && isEffectInvalid(err)) {
          this.badEffects.add(o.effect);
          log.warn(`message effect ${o.effect} rejected — blacklisted`);
          o = { ...o, effect: undefined };
          continue;
        }
        if ((o.replyTo || o.replyToEphemeral) && isReplyNotFound(err)) {
          o = { ...o, replyTo: undefined, replyToEphemeral: undefined };
          continue;
        }
        if (o.threadId && isThreadNotFound(err)) {
          o = { ...o, threadId: undefined };
          continue;
        }
        if (isRateLimited(err) && attempt < 2) {
          const wait = Math.min(30, retryAfterSec(err) ?? 3);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        throw err;
      }
    }
    return fn(o);
  }

  // ------------------------------------------------------------ markdown (AI answers)

  /** Send model markdown; splits into several messages when needed. */
  async sendMarkdown(chatId: number, md: string, opts: SendOpts = {}): Promise<Message[]> {
    const sent: Message[] = [];
    if (this.useRich(opts.classic)) {
      const parts = splitMarkdown(md, RICH_MAX_BYTES);
      for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx] as string;
        const first = idx === 0;
        const last = idx === parts.length - 1;
        try {
          const msg = await this.withRepairs(
            (o) =>
              this.api.sendRichMessage(chatId, { markdown: part }, {
                message_thread_id: o.threadId,
                reply_parameters: first ? this.replyParams(o) : undefined,
                reply_markup: last ? o.keyboard : undefined,
                message_effect_id: first ? this.effectFor(o) : undefined,
                ephemeral_message_parameters: o.ephemeral,
                disable_notification: o.silent || !first ? true : undefined,
              }),
            opts,
          );
          sent.push(msg);
        } catch (err) {
          if (isUnknownMethod(err)) {
            this.richUnsupported = true;
            log.warn('sendRichMessage unsupported by this Bot API server — using classic HTML from now on');
          }
          if (isDefinitiveRejection(err)) {
            log.warn(`rich message rejected (${tgDescription(err)}) — classic fallback`);
            const rest = parts.slice(idx).join('\n\n');
            sent.push(...(await this.sendClassic(chatId, rest, { ...opts, replyTo: first ? opts.replyTo : undefined })));
            return sent;
          }
          throw err;
        }
      }
      return sent;
    }
    return this.sendClassic(chatId, md, opts);
  }

  private async sendClassic(chatId: number, md: string, opts: SendOpts): Promise<Message[]> {
    const parts = splitMarkdown(md, CLASSIC_MAX_CHARS, charLength);
    const sent: Message[] = [];
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx] as string;
      const first = idx === 0;
      const last = idx === parts.length - 1;
      const common = (o: SendOpts) => ({
        message_thread_id: o.threadId,
        reply_parameters: first ? this.replyParams(o) : undefined,
        reply_markup: last ? o.keyboard : undefined,
        message_effect_id: first ? this.effectFor(o) : undefined,
        ephemeral_message_parameters: o.ephemeral,
        disable_notification: o.silent || !first ? true : undefined,
        link_preview_options: { is_disabled: true },
      });
      try {
        sent.push(await this.withRepairs((o) => this.api.sendMessage(chatId, markdownToHtml(part) || '…', { ...common(o), parse_mode: 'HTML' }), opts));
      } catch (err) {
        if (!isDefinitiveRejection(err)) throw err;
        log.warn(`HTML rejected (${tgDescription(err)}) — sending plain text`);
        sent.push(await this.withRepairs((o) => this.api.sendMessage(chatId, part.slice(0, 4096) || '…', common(o)), opts));
      }
    }
    return sent;
  }

  /** Edit a message/inline message/ephemeral message with markdown (single message). */
  async editMarkdown(target: EditTarget, md: string, opts: { keyboard?: InlineKeyboardMarkup; classic?: boolean } = {}): Promise<EditResult> {
    const content = md.trim() || '…';
    if (this.useRich(opts.classic)) {
      const single = splitMarkdown(content, RICH_MAX_BYTES)[0] as string;
      try {
        await this.editRaw(target, { markdown: single }, opts.keyboard);
        return 'ok';
      } catch (err) {
        if (isNotModified(err)) return 'unchanged';
        if (isRateLimited(err)) {
          this.noteCooldown(target, err);
          return 'rate_limited';
        }
        if (isUnknownMethod(err)) this.richUnsupported = true;
        if (!isDefinitiveRejection(err)) {
          log.warn(`edit failed: ${tgDescription(err)}`);
          return 'failed';
        }
        log.warn(`rich edit rejected (${tgDescription(err)}) — classic fallback`);
      }
    }
    const single = splitMarkdown(content, CLASSIC_SINGLE_MAX, charLength)[0] as string;
    try {
      await this.editRaw(target, markdownToHtml(single) || '…', opts.keyboard, 'HTML');
      return 'ok';
    } catch (err) {
      if (isNotModified(err)) return 'unchanged';
      if (isRateLimited(err)) {
        this.noteCooldown(target, err);
        return 'rate_limited';
      }
      if (!isDefinitiveRejection(err)) return 'failed';
      try {
        await this.editRaw(target, single.slice(0, 4096), opts.keyboard);
        return 'ok';
      } catch (err2) {
        return isNotModified(err2) ? 'unchanged' : 'failed';
      }
    }
  }

  private noteCooldown(target: EditTarget, err: unknown): void {
    const key = target.kind === 'inline' ? target.inlineMessageId : `${target.chatId}`;
    this.cooldowns.set(key, Date.now() + (retryAfterSec(err) ?? 3) * 1000);
  }

  cooldownLeft(target: EditTarget): number {
    const key = target.kind === 'inline' ? target.inlineMessageId : `${target.chatId}`;
    return Math.max(0, (this.cooldowns.get(key) ?? 0) - Date.now());
  }

  private async editRaw(
    target: EditTarget,
    content: string | { markdown?: string; blocks?: Screen['blocks'] },
    keyboard?: InlineKeyboardMarkup,
    parseMode?: 'HTML',
  ): Promise<void> {
    const other = {
      reply_markup: keyboard,
      ...(typeof content === 'string' ? { parse_mode: parseMode, link_preview_options: { is_disabled: true } } : {}),
    };
    const payload = content as Parameters<Api['editMessageText']>[2];
    if (target.kind === 'message') await this.api.editMessageText(target.chatId, target.messageId, payload, other);
    else if (target.kind === 'inline') await this.api.editMessageTextInline(target.inlineMessageId, payload, other);
    else await this.api.editEphemeralMessageText(target.chatId, target.receiverUserId, target.ephemeralMessageId, payload, other);
  }

  // ------------------------------------------------------------ drafts (private streaming)

  /** Stream a partial answer (private chats). Never throws; returns false when drafts failed. */
  async draft(chatId: number, draftId: number, md: string, opts: { threadId?: number; canStop?: boolean; classic?: boolean } = {}): Promise<boolean> {
    if (this.draftsUnsupported) return false;
    const stop = opts.canStop ? { can_stop: true, keep_on_stop: true } : {};
    if (this.useRich(opts.classic) && !this.richDraftsUnsupported) {
      try {
        await this.api.sendRichMessageDraft(chatId, draftId, { markdown: md || '…' }, { message_thread_id: opts.threadId, ...stop });
        return true;
      } catch (err) {
        if (isUnknownMethod(err)) {
          this.richDraftsUnsupported = true;
          log.warn('sendRichMessageDraft unsupported — using sendMessageDraft');
        } else if (!isDefinitiveRejection(err)) {
          log.debug(`draft failed: ${tgDescription(err)}`);
          return !isRateLimited(err);
        }
      }
    }
    try {
      const html = markdownToHtml(md.replace(/<tg-thinking>([\s\S]*?)<\/tg-thinking>/g, '_$1_')).slice(0, 4000);
      await this.api.sendMessageDraft(chatId, draftId, html || '…', { parse_mode: 'HTML', message_thread_id: opts.threadId, ...stop });
      return true;
    } catch (err) {
      if (isUnknownMethod(err)) {
        this.draftsUnsupported = true;
        log.warn('sendMessageDraft unsupported — private streaming will use message edits');
      }
      return false;
    }
  }

  // ------------------------------------------------------------ screens (UI built from blocks)

  async sendScreen(chatId: number, screen: Screen, opts: SendOpts = {}): Promise<Message> {
    const o = { ...opts, keyboard: screen.keyboard ?? opts.keyboard, effect: screen.effect ?? opts.effect };
    if (this.useRich(opts.classic)) {
      try {
        return await this.withRepairs(
          (x) =>
            this.api.sendRichMessage(chatId, { blocks: screen.blocks }, {
              message_thread_id: x.threadId,
              reply_parameters: this.replyParams(x),
              reply_markup: x.keyboard,
              message_effect_id: this.effectFor(x),
              ephemeral_message_parameters: x.ephemeral,
            }),
          o,
        );
      } catch (err) {
        if (isUnknownMethod(err)) this.richUnsupported = true;
        if (!isDefinitiveRejection(err)) throw err;
        log.warn(`rich screen rejected (${tgDescription(err)}) — classic fallback`);
      }
    }
    const keyboard = mergeKeyboards(buttonsToKeyboard(screen.blocks), o.keyboard);
    return this.withRepairs(
      (x) =>
        this.api.sendMessage(chatId, blocksToHtml(screen.blocks) || '…', {
          parse_mode: 'HTML',
          message_thread_id: x.threadId,
          reply_parameters: this.replyParams(x),
          reply_markup: keyboard,
          message_effect_id: this.effectFor(x),
          ephemeral_message_parameters: x.ephemeral,
          link_preview_options: { is_disabled: true },
        }),
      o,
    );
  }

  async editScreen(target: EditTarget, screen: Screen, opts: { classic?: boolean } = {}): Promise<EditResult> {
    if (this.useRich(opts.classic)) {
      try {
        await this.editRaw(target, { blocks: screen.blocks }, screen.keyboard);
        return 'ok';
      } catch (err) {
        if (isNotModified(err)) return 'unchanged';
        if (isUnknownMethod(err)) this.richUnsupported = true;
        if (!isDefinitiveRejection(err)) return 'failed';
      }
    }
    try {
      await this.editRaw(target, blocksToHtml(screen.blocks) || '…', mergeKeyboards(buttonsToKeyboard(screen.blocks), screen.keyboard), 'HTML');
      return 'ok';
    } catch (err) {
      return isNotModified(err) ? 'unchanged' : 'failed';
    }
  }
}

export function mergeKeyboards(extra: InlineKeyboardMarkup['inline_keyboard'], base?: InlineKeyboardMarkup): InlineKeyboardMarkup | undefined {
  const rows = [...extra, ...(base?.inline_keyboard ?? [])];
  if (!rows.length) return base;
  return base?.force_reply ? { inline_keyboard: rows, force_reply: true } : { inline_keyboard: rows };
}
