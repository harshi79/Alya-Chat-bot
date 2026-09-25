/**
 * grammY wiring: middleware, commands, callbacks, messages (private / group),
 * guest mode, inline mode, ephemeral commands, reactions and stop updates.
 *
 * Handlers never await AI work — they enqueue a Job and return, so the update
 * loop stays responsive (⏹ and callbacks are handled instantly).
 */
import { Bot, InputFile, type Context } from 'grammy';
import type { Message, ReactionTypeEmoji, User, UserFromGetMe } from 'grammy/types';
import { isMaintenance, chatModel, type App } from '../app.js';
import { RateLimiter, WindowCounter } from '../ai/limiter.js';
import { NvidiaClient } from '../ai/nvidia.js';
import { imagePromptProblem, Senses } from '../ai/services.js';
import { ActiveRegistry } from '../chat/active.js';
import { runTurn, sendVoiceReply } from '../chat/engine.js';
import { chooseEffect, EFFECTS, pickReaction } from '../chat/policy.js';
import { ConvQueue } from '../chat/queue.js';
import { DraftSink, InlineSink, MessageEditSink, type Sink } from '../chat/sinks.js';
import { isAdmin, type Config } from '../config.js';
import { convKey, Store, type ReplyRecord, type UserRow } from '../db/store.js';
import { logger } from '../log.js';
import type { ChatKind } from '../persona/alya.js';
import { lines } from '../persona/lines.js';
import { dailyMood } from '../persona/mood.js';
import { Renderer, type EditTarget } from '../rich/render.js';
import { isBlockedByUser, tgDescription } from '../util/tgerrors.js';
import { shortId, truncate } from '../util/text.js';
import { dayKey, isValidTimeZone } from '../util/time.js';
import { registerAdmin } from './admin.js';
import { extractIncoming, logMediaFailure, perceive, stripMention, type Incoming } from './media.js';
import {
  aboutScreen,
  askScreen,
  confirmWipeScreen,
  groupSettingsScreen,
  groupWelcomeScreen,
  helpScreen,
  memoryScreen,
  privateOnlyScreen,
  profileScreen,
  remindersScreen,
  settingsScreen,
  urlBtn,
  welcomeScreen,
} from './screens.js';
import type { Screen } from '../rich/blocks.js';

const log = logger('bot');

export interface Job {
  kind: ChatKind;
  from: User;
  chatId: number | null;
  chatTitle?: string;
  threadId?: number;
  conv: string;
  incoming?: Incoming;
  userMessageId?: number;
  mode: 'normal' | 'regenerate' | 'deep';
  reply?: ReplyRecord;
  synthetic?: string;
  persistUser: boolean;
  guestQueryId?: string;
  inlineMessageId?: string;
  effect?: string;
}

export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'inline_query',
  'chosen_inline_result',
  'my_chat_member',
  'message_reaction',
  'guest_message',
  'stopped_message_generation',
] as const;

interface PendingAsk {
  kind: 'nickname' | 'timezone' | 'imagine' | 'quiz';
  chatId: number;
  messageId?: number;
  expires: number;
}

const POSITIVE_REACTIONS = new Set(['❤', '❤️', '🔥', '🥰', '😍', '👍', '💯', '🏆', '🤩', '😘', '💘', '❤‍🔥', '👏']);

const CITY_TZ: Record<string, string> = {
  mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', kolkata: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata',
  pune: 'Asia/Kolkata', chennai: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', ahmedabad: 'Asia/Kolkata', jaipur: 'Asia/Kolkata', lucknow: 'Asia/Kolkata', india: 'Asia/Kolkata',
  moscow: 'Europe/Moscow', 'saint petersburg': 'Europe/Moscow', 'st petersburg': 'Europe/Moscow', piter: 'Europe/Moscow', london: 'Europe/London', paris: 'Europe/Paris',
  berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome', istanbul: 'Europe/Istanbul', kyiv: 'Europe/Kyiv', dubai: 'Asia/Dubai', karachi: 'Asia/Karachi',
  lahore: 'Asia/Karachi', dhaka: 'Asia/Dhaka', kathmandu: 'Asia/Kathmandu', colombo: 'Asia/Colombo', singapore: 'Asia/Singapore', jakarta: 'Asia/Jakarta',
  manila: 'Asia/Manila', bangkok: 'Asia/Bangkok', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', 'new york': 'America/New_York', nyc: 'America/New_York',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', chicago: 'America/Chicago', toronto: 'America/Toronto', 'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo', cairo: 'Africa/Cairo', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi', almaty: 'Asia/Almaty', tashkent: 'Asia/Tashkent',
};

export interface BuiltBot {
  bot: Bot;
  app: App;
  queue: ConvQueue<Job>;
}

export async function buildBot(cfg: Config, opts: { store?: Store; botInfo?: UserFromGetMe; fetchImpl?: typeof fetch } = {}): Promise<BuiltBot> {
  const bot = new Bot(cfg.botToken || '0:offline', { botInfo: opts.botInfo, client: { apiRoot: cfg.apiRoot } });
  if (!opts.botInfo) await bot.init();
  const store = opts.store ?? new Store(cfg.dbFile);
  const limiter = new RateLimiter(cfg.nvidiaRpm);
  const ai = new NvidiaClient({
    apiKey: cfg.nvidiaKey,
    baseUrl: cfg.nvidiaBaseUrl,
    genaiUrl: cfg.genaiBaseUrl,
    nvcfTemplate: cfg.nvcfUrlTemplate,
    limiter,
    timeoutMs: cfg.aiTimeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  const app: App = {
    cfg,
    store,
    ai,
    senses: new Senses(ai, cfg),
    api: bot.api,
    me: bot.botInfo,
    renderer: new Renderer(bot.api),
    active: new ActiveRegistry(),
    flags: { toolsBroken: false, maintenance: store.getKv('maintenance') === '1' },
    lastReply: new Map(),
    startedAt: Date.now(),
  };
  const queue = new ConvQueue<Job>((conv, batch) => processJobs(app, conv, batch), canMerge, 8);
  registerHandlers(bot, app, queue);
  return { bot, app, queue };
}

function canMerge(a: Job, b: Job): boolean {
  const plain = (j: Job) => j.mode === 'normal' && !j.synthetic && !j.guestQueryId && !j.inlineMessageId && j.incoming !== undefined && !j.incoming.media;
  return plain(a) && plain(b) && a.from.id === b.from.id && a.kind === b.kind;
}

// ---------------------------------------------------------------- worker

async function processJobs(app: App, conv: string, batch: Job[]): Promise<void> {
  const first = batch[0] as Job;
  const last = batch[batch.length - 1] as Job;
  const job: Job =
    batch.length > 1 && first.incoming
      ? { ...last, incoming: { ...last.incoming!, text: batch.map((j) => j.incoming?.text ?? '').filter(Boolean).join('\n'), replyContext: first.incoming.replyContext } }
      : first;
  const user = app.store.getUser(job.from.id);
  const classic = user?.settings.classic ?? false;
  const gen = app.active.start({ ownerId: job.from.id, conv, chatId: job.chatId ?? undefined });
  try {
    let sink: Sink;
    const existing = job.reply?.message_id ?? undefined;
    if (job.kind === 'guest') {
      sink = new InlineSink(app, { guestQueryId: job.guestQueryId, classic, footer: { inline_keyboard: [[urlBtn('💬 Chat with Alya', `https://t.me/${app.me.username}?start=guest`)]] } });
    } else if (job.kind === 'inline') {
      sink = new InlineSink(app, { inlineMessageId: job.inlineMessageId, classic, footer: { inline_keyboard: [[urlBtn('💬 Chat with Alya', `https://t.me/${app.me.username}?start=inline`)]] } });
    } else if (job.kind === 'private' && !existing && !app.renderer.draftsUnsupported) {
      sink = new DraftSink(app, job.chatId as number, { threadId: job.threadId, classic, gen });
    } else {
      sink = new MessageEditSink(app, job.chatId as number, {
        threadId: job.threadId,
        replyTo: existing ? undefined : job.userMessageId,
        classic,
        isPrivate: job.kind === 'private',
        stopToken: gen.token,
        existingMessageId: existing,
      });
    }

    let languageText = job.incoming?.text;
    const perception = job.incoming ? perceive(app, job.incoming, (transcript) => {
      languageText = [transcript, job.incoming?.text].filter(Boolean).join('\n');
    }) : { extras: [] as string[], voiceIn: false, status: undefined, process: undefined, statKey: undefined };
    if (perception.statKey) app.store.incStat(perception.statKey);
    const baseText = job.reply?.prompt ?? job.synthetic ?? '';
    await runTurn(app, {
      kind: job.kind,
      from: job.from,
      chatId: job.chatId,
      chatTitle: job.chatTitle,
      threadId: job.threadId,
      conv,
      userText: baseText,
      getLanguageText: () => languageText,
      extras: perception.extras,
      sink,
      gen,
      mode: job.mode,
      persistUser: job.persistUser,
      userMessageId: job.userMessageId,
      voiceIn: perception.voiceIn,
      classic,
      effect: job.effect,
      status: perception.status,
      prepare: perception.process
        ? async (update, signal) => {
            let text: string;
            try {
              text = await perception.process!(update, signal);
            } catch (err) {
              if (signal.aborted) throw err;
              logMediaFailure(job.incoming?.media?.kind ?? 'message', err);
              const what = job.incoming?.media?.kind?.replace('_', ' ') ?? 'something';
              text = [job.incoming?.replyContext, `[sent a ${what}, but you couldn't open it — say so kindly]`, job.incoming?.text].filter(Boolean).join('\n');
            }
            return text.trim() ? text : null;
          }
        : undefined,
    });
  } finally {
    app.active.finish(gen);
  }
}

// ---------------------------------------------------------------- helpers

function kindOf(ctx: Context): ChatKind {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup' ? 'group' : 'private';
}

function threadOf(msg: Message | undefined): number | undefined {
  if (!msg) return undefined;
  if (msg.chat.type === 'private') return msg.is_topic_message ? msg.message_thread_id : undefined;
  return msg.is_topic_message ? msg.message_thread_id : undefined;
}

function convOf(msg: Message): string {
  return convKey(msg.chat.id, threadOf(msg));
}

function ephemeralIdOf(msg: Message | undefined): number | undefined {
  const id = (msg as (Message & { ephemeral_message_id?: number }) | undefined)?.ephemeral_message_id;
  return typeof id === 'number' && id > 0 ? id : undefined;
}

async function showScreen(app: App, ctx: Context, screen: Screen, opts: { personal?: boolean; what?: string } = {}): Promise<void> {
  const chat = ctx.chat;
  if (!chat || !ctx.from) return;
  const user = app.store.getUser(ctx.from.id);
  const classic = user?.settings.classic;
  const msg = ctx.msg;
  const isPrivate = chat.type === 'private';
  if (!isPrivate && opts.personal) {
    const eph = ephemeralIdOf(msg);
    if (eph) {
      await app.renderer.sendScreen(chat.id, screen, { ephemeral: { receiver_user_id: ctx.from.id }, replyToEphemeral: eph, classic });
      return;
    }
    // Not an ephemeral command (old client) — don't leak personal data to the group.
    await app.renderer.sendScreen(chat.id, privateOnlyScreen(app.me, opts.what ?? 'this'), { replyTo: msg?.message_id, threadId: threadOf(msg) });
    return;
  }
  await app.renderer.sendScreen(chat.id, screen, { threadId: threadOf(msg), isPrivate, classic, replyTo: isPrivate ? undefined : msg?.message_id });
}

async function editFromCallback(app: App, ctx: Context, screen: Screen): Promise<void> {
  const m = ctx.callbackQuery?.message;
  if (!m || !ctx.from) return;
  const classic = app.store.getUser(ctx.from.id)?.settings.classic;
  const eph = ephemeralIdOf(m as Message);
  const target: EditTarget = eph
    ? { kind: 'ephemeral', chatId: m.chat.id, receiverUserId: ctx.from.id, ephemeralMessageId: eph }
    : { kind: 'message', chatId: m.chat.id, messageId: m.message_id };
  const r = await app.renderer.editScreen(target, screen, { classic });
  if (r === 'failed') await app.renderer.sendScreen(m.chat.id, screen, { classic, isPrivate: m.chat.type === 'private' }).catch(() => undefined);
}

function screenFor(app: App, name: string, user: UserRow, page = 0): Screen | null {
  switch (name) {
    case 'home':
      return welcomeScreen(app.me, user.first_name || 'friend', false);
    case 'help':
      return helpScreen(app.me);
    case 'about':
      return aboutScreen(new Date(), app.cfg.developerUrl);
    case 'settings':
      return settingsScreen(user);
    case 'profile':
      return profileScreen(user, app.store.listMemories(user.id).length, app.store.pendingReminders(user.id).length, app.me);
    case 'memory':
      return memoryScreen(app.store.listMemories(user.id), page);
    case 'reminders':
      return remindersScreen(app.store.pendingReminders(user.id));
    default:
      return null;
  }
}

async function resolveTimezone(app: App, input: string): Promise<string | null> {
  const raw = input.trim();
  if (isValidTimeZone(raw) && raw.includes('/')) return raw;
  const key = raw.toLowerCase().replace(/[^\p{L} ]/gu, '').trim();
  if (CITY_TZ[key]) return CITY_TZ[key] as string;
  if (!app.ai.enabled) return null;
  try {
    const out = await app.ai.completeJson<{ timezone?: string }>(
      {
        model: app.cfg.lightModel,
        messages: [
          { role: 'system', content: 'Convert the place the user mentions into its IANA timezone. Output JSON {"timezone": "Area/City"} or {"timezone": null} if unknown.' },
          { role: 'user', content: truncate(raw, 100) },
        ],
        temperature: 0,
        max_tokens: 40,
      },
      { priority: 'high' },
    );
    return out?.timezone && isValidTimeZone(out.timezone) ? out.timezone : null;
  } catch {
    return null;
  }
}

async function generateQuiz(app: App, chatId: number, topic: string, threadId?: number): Promise<void> {
  const q = await app.ai.completeJson<{ question?: string; options?: string[]; correct_option_ids?: number[]; explanation?: string }>(
    {
      model: chatModel(app),
      messages: [
        {
          role: 'system',
          content:
            'You write one fun, accurate multiple-choice quiz question. Output only JSON: {"question": string (max 250 chars), "options": [4 short strings], "correct_option_ids": [index of the correct option], "explanation": string (max 180 chars, playful)}.',
        },
        { role: 'user', content: `Topic: ${truncate(topic, 200)}` },
      ],
      temperature: 0.9,
      max_tokens: 600,
    },
    { priority: 'high' },
  );
  const options = (q?.options ?? []).map((o) => String(o).slice(0, 100)).filter(Boolean).slice(0, 10);
  const correct = (q?.correct_option_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
  if (!q?.question || options.length < 2 || !correct.length) throw new Error('quiz generation failed');
  await app.api.sendPoll(chatId, q.question.slice(0, 300), options.map((text) => ({ text })), {
    message_thread_id: threadId,
    type: 'quiz',
    is_anonymous: false,
    correct_option_ids: correct,
    allows_multiple_answers: correct.length > 1 ? true : undefined,
    explanation: q.explanation?.slice(0, 200),
    description: `🧩 Alya's quiz — ${truncate(topic, 80)}`,
  });
}

async function drawImage(app: App, ctx: Context, prompt: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const threadId = threadOf(ctx.msg);
  const userId = ctx.from!.id;
  if (imagePromptProblem(prompt)) {
    await ctx.reply('Ты что?! I\'m not drawing that 😤');
    return;
  }
  const day = dayKey(new Date(), app.cfg.defaultTimezone);
  if (app.cfg.dailyImageLimit > 0 && !isAdmin(userId, app.cfg) && app.store.getUsage(day, userId, 'image') >= app.cfg.dailyImageLimit) {
    await ctx.reply(lines.imageLimit());
    return;
  }
  const status = await ctx.reply(lines.drawing(), { message_thread_id: threadId }).catch(() => null);
  void app.api.sendChatAction(chatId, 'upload_photo', { message_thread_id: threadId }).catch(() => undefined);
  try {
    const img = await app.senses.generateImage(prompt);
    await app.api.sendPhoto(chatId, new InputFile(img.image, img.mime === 'image/png' ? 'alya.png' : 'alya.jpg'), {
      message_thread_id: threadId,
      caption: `🎨 ${truncate(prompt, 300)}\n\n${['Here! Don\'t laugh at my art 😤', 'Ta-da ✨', 'I tried my best… do you like it? 🙈'][Math.floor(Math.random() * 3)]}`,
    });
    app.store.incUsage(day, userId, 'image');
    app.store.incStat('images');
  } catch (err) {
    log.warn(`image failed: ${(err as Error).message}`);
    await ctx.reply(/safety|blocked/i.test((err as Error).message) ? 'The art filter said no 🙈' : 'My drawing failed 😣 Try again later?');
  } finally {
    if (status) void app.api.deleteMessage(chatId, status.message_id).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- registration

function registerHandlers(bot: Bot, app: App, queue: ConvQueue<Job>): void {
  const cfg = app.cfg;
  const flood = new WindowCounter(cfg.userMsgsPerMin, 60_000);
  const warned = new WindowCounter(1, 60_000);
  const pending = new Map<number, PendingAsk>();
  const reactedTo = new Set<string>();

  bot.catch((err) => log.error(`update ${err.ctx.update.update_id} failed: ${tgDescription(err.error)}`));

  // Stop generation (Bot API 10.3) — first, and never blocked by other middleware.
  bot.on('stopped_message_generation', (ctx) => {
    const s = ctx.update.stopped_message_generation!;
    const ok = app.active.stopByDraft(s.chat.id, s.draft_id as unknown as number | string);
    log.debug(`stop for draft ${String(s.draft_id)}: ${ok ? 'stopped' : 'not running'}`);
  });

  // Track users/chats, bans and maintenance.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && !from.is_bot) {
      app.store.upsertUser({ id: from.id, first_name: from.first_name, last_name: from.last_name, username: from.username, language_code: from.language_code });
      const u = app.store.getUser(from.id);
      if (u?.banned && !isAdmin(from.id, cfg)) return;
    }
    if (ctx.chat && ctx.chat.type !== 'private' && ctx.chat.type !== 'channel' && !ctx.update.guest_message) {
      app.store.upsertChat({ id: ctx.chat.id, type: ctx.chat.type, title: 'title' in ctx.chat ? ctx.chat.title : undefined });
    }
    if (isMaintenance(app) && from && !isAdmin(from.id, cfg)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: lines.maintenance() }).catch(() => undefined);
      else if (ctx.chat?.type === 'private' && ctx.message && warned.hit(`m:${from.id}`)) await ctx.reply(lines.maintenance()).catch(() => undefined);
      return;
    }
    await next();
  });

  registerAdmin(bot, app, queue as ConvQueue<unknown>);

  // ------------------------------------------------------------ commands

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await app.renderer.sendScreen(ctx.chat.id, groupWelcomeScreen(app.me), { threadId: threadOf(ctx.msg) });
      return;
    }
    const payload = ctx.match.trim();
    const user = app.store.getUser(ctx.from!.id)!;
    const isNew = user.messages === 0 && Date.now() - user.created_at < 120_000;
    if (payload.startsWith('ref_') && isNew) {
      const ref = Number(payload.slice(4));
      if (ref && ref !== user.id && app.store.getUser(ref)) {
        app.store.setUserField(user.id, 'referred_by', ref);
        app.store.addBond(ref, 3);
      }
    }
    const direct: Record<string, string> = { settings: 'settings', memory: 'memory', profile: 'profile', reminders: 'reminders', help: 'help', about: 'about' };
    const target = direct[payload];
    if (target) {
      const scr = screenFor(app, target, user);
      if (scr) return showScreen(app, ctx, scr);
    }
    const scr = welcomeScreen(app.me, ctx.from!.first_name, isNew);
    if (isNew) scr.effect = EFFECTS.party;
    await showScreen(app, ctx, scr);
  });

  bot.command('help', (ctx) => showScreen(app, ctx, helpScreen(app.me), { personal: true, what: 'help' }));
  bot.command('about', (ctx) => showScreen(app, ctx, aboutScreen(new Date(), cfg.developerUrl)));
  for (const name of ['settings', 'memory', 'profile', 'reminders'] as const) {
    bot.command(name, async (ctx) => {
      const user = app.store.getUser(ctx.from!.id);
      if (!user) return;
      const scr = screenFor(app, name, user);
      if (scr) await showScreen(app, ctx, scr, { personal: true, what: name });
    });
  }

  bot.command('forget', async (ctx) => {
    if (ctx.chat.type !== 'private') return showScreen(app, ctx, privateOnlyScreen(app.me, 'forget'), {});
    await showScreen(app, ctx, confirmWipeScreen('everything'));
  });

  bot.command('stop', async (ctx) => {
    const n = app.active.stopConv(convOf(ctx.msg), ctx.from!.id);
    if (!n) await ctx.reply('I\'m not saying anything right now 🙊');
  });

  bot.command('new', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === 'private') {
      if (app.me.has_topics_enabled) {
        try {
          const topic = await app.api.createForumTopic(chat.id, '💬 New chat');
          app.store.upsertTopic(chat.id, topic.message_thread_id, topic.name, false);
          await app.api.sendMessage(chat.id, 'New chat ✨ What\'s on your mind?', { message_thread_id: topic.message_thread_id });
          return;
        } catch (err) {
          log.warn(`createForumTopic failed: ${tgDescription(err)}`);
        }
      }
      app.store.clearConversation(convOf(ctx.msg));
      await ctx.reply('Fresh start ✨ I still remember the important things about you — ask /memory. So… what\'s new?');
      return;
    }
    const member = await ctx.getChatMember(ctx.from!.id).catch(() => null);
    if (!isAdmin(ctx.from!.id, cfg) && !(member && (member.status === 'administrator' || member.status === 'creator'))) {
      await ctx.reply('Only group admins can reset my memory of this chat 🙅‍♀️');
      return;
    }
    app.store.clearConversation(convOf(ctx.msg));
    await ctx.reply('Okay, I forgot this chat\'s conversation. Clean slate ✨');
  });

  bot.command('imagine', async (ctx) => {
    const prompt = stripMention(ctx.match, app.me.username);
    if (!prompt) {
      const m = await app.renderer.sendScreen(ctx.chat.id, askScreen('imagine'), { threadId: threadOf(ctx.msg), isPrivate: ctx.chat.type === 'private' });
      pending.set(ctx.from!.id, { kind: 'imagine', chatId: ctx.chat.id, messageId: m.message_id, expires: Date.now() + 10 * 60_000 });
      return;
    }
    void drawImage(app, ctx, prompt);
  });

  bot.command('quiz', async (ctx) => {
    const topic = stripMention(ctx.match, app.me.username);
    if (!topic) {
      const m = await app.renderer.sendScreen(ctx.chat.id, askScreen('quiz'), { threadId: threadOf(ctx.msg), isPrivate: ctx.chat.type === 'private' });
      pending.set(ctx.from!.id, { kind: 'quiz', chatId: ctx.chat.id, messageId: m.message_id, expires: Date.now() + 10 * 60_000 });
      return;
    }
    void generateQuiz(app, ctx.chat.id, topic, threadOf(ctx.msg)).catch(async () => {
      await ctx.reply('My quiz brain froze 🥶 Try another topic?').catch(() => undefined);
    });
  });

  bot.command('voice', async (ctx) => {
    const last = app.store.lastAssistantMessage(convOf(ctx.msg));
    if (!last) return ctx.reply('I haven\'t said anything yet 🙈');
    void (async () => {
      try {
        const ok = await sendVoiceReply(app, ctx.chat.id, last.content, { threadId: threadOf(ctx.msg), replyTo: last.tg_message_id ?? undefined, userId: ctx.from!.id });
        if (!ok) await ctx.reply(lines.voiceLimit());
      } catch (err) {
        log.warn(`voice failed: ${(err as Error).message}`);
        await ctx.reply('My voice isn\'t working right now 😣').catch(() => undefined);
      }
    })();
  });

  bot.command('groupsettings', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('This is for groups 🙂');
    const member = await ctx.getChatMember(ctx.from!.id).catch(() => null);
    if (!isAdmin(ctx.from!.id, cfg) && !(member && (member.status === 'administrator' || member.status === 'creator'))) return ctx.reply('Only admins 🙅‍♀️');
    const chat = app.store.getChat(ctx.chat.id);
    await app.renderer.sendScreen(ctx.chat.id, groupSettingsScreen(chat?.settings ?? { replyMode: 'name', reactions: true }), { threadId: threadOf(ctx.msg) });
  });

  // ------------------------------------------------------------ callbacks

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const from = ctx.from;
    const user = app.store.getUser(from.id);
    if (!user) return ctx.answerCallbackQuery();
    const [head, a1, a2, a3] = data.split(':');
    try {
      switch (head) {
        case 'stop': {
          const r = app.active.stopByToken(a1 ?? '', from.id, isAdmin(from.id, cfg));
          await ctx.answerCallbackQuery({ text: r === 'stopped' ? '⏹ Stopped' : r === 'not_owner' ? 'Only the person who asked can stop me 😤' : 'Already finished ✨' });
          return;
        }
        case 'talk': {
          await ctx.answerCallbackQuery();
          const chat = ctx.chat;
          if (!chat) return;
          queue.push(convKey(chat.id), {
            kind: 'private',
            from,
            chatId: chat.id,
            conv: convKey(chat.id),
            mode: 'normal',
            persistUser: false,
            synthetic: '[The person just opened the chat and tapped "Let\'s talk". Greet them warmly in your style and ask one question to get to know them.]',
          });
          return;
        }
        case 'scr': {
          await ctx.answerCallbackQuery();
          const scr = screenFor(app, a1 ?? 'home', user);
          if (scr) await editFromCallback(app, ctx, scr);
          return;
        }
        case 'set': {
          if (a1 === 'g') {
            const chatId = ctx.chat?.id;
            if (!chatId) return ctx.answerCallbackQuery();
            const member = await ctx.getChatMember(from.id).catch(() => null);
            if (!isAdmin(from.id, cfg) && !(member && (member.status === 'administrator' || member.status === 'creator'))) {
              return ctx.answerCallbackQuery({ text: 'Only admins 🙅‍♀️' });
            }
            const cur = app.store.getChat(chatId)?.settings ?? { replyMode: 'name' as const, reactions: true };
            const next = a2 === 'reply' ? app.store.updateChatSettings(chatId, { replyMode: a3 === 'mention' ? 'mention' : 'name' }) : app.store.updateChatSettings(chatId, { reactions: !cur.reactions });
            await ctx.answerCallbackQuery({ text: 'Saved ✨' });
            await editFromCallback(app, ctx, groupSettingsScreen(next));
            return;
          }
          const s = user.settings;
          if (a1 === 'voice' && (a2 === 'off' || a2 === 'auto' || a2 === 'always')) app.store.updateUserSettings(from.id, { voice: a2 });
          else if (a1 === 'brain' && (a2 === 'fast' || a2 === 'auto' || a2 === 'deep')) app.store.updateUserSettings(from.id, { brain: a2 });
          else if (a1 === 'thoughts') app.store.updateUserSettings(from.id, { showThoughts: !s.showThoughts });
          else if (a1 === 'effects') app.store.updateUserSettings(from.id, { effects: !s.effects });
          else if (a1 === 'reactions') app.store.updateUserSettings(from.id, { reactions: !s.reactions });
          else if (a1 === 'classic') app.store.updateUserSettings(from.id, { classic: !s.classic });
          await ctx.answerCallbackQuery({ text: 'Saved ✨' });
          await editFromCallback(app, ctx, settingsScreen(app.store.getUser(from.id)!));
          return;
        }
        case 'ask': {
          if (a1 === 'cancel') {
            pending.delete(from.id);
            await ctx.answerCallbackQuery({ text: 'Okay, never mind 🙂' });
            const m = ctx.callbackQuery.message;
            if (m && !ephemeralIdOf(m as Message)) await app.api.deleteMessage(m.chat.id, m.message_id).catch(() => undefined);
            return;
          }
          if (a1 === 'nickname' || a1 === 'timezone') {
            await ctx.answerCallbackQuery();
            const chat = ctx.chat;
            if (!chat) return;
            if (chat.type !== 'private') {
              await ctx.answerCallbackQuery({ text: 'Let\'s do that in private chat 🤫' }).catch(() => undefined);
              return;
            }
            const m = await app.renderer.sendScreen(chat.id, askScreen(a1), { isPrivate: true, classic: user.settings.classic });
            pending.set(from.id, { kind: a1, chatId: chat.id, messageId: m.message_id, expires: Date.now() + 10 * 60_000 });
          }
          return;
        }
        case 'mem': {
          if (a1 === 'del') {
            app.store.deleteMemory(from.id, Number(a2));
            await ctx.answerCallbackQuery({ text: 'Forgotten 🫧' });
            await editFromCallback(app, ctx, memoryScreen(app.store.listMemories(from.id), Number(a3) || 0));
          } else if (a1 === 'page') {
            await ctx.answerCallbackQuery();
            await editFromCallback(app, ctx, memoryScreen(app.store.listMemories(from.id), Number(a2) || 0));
          } else if (a1 === 'wipe' && a2 === 'yes') {
            const n = app.store.clearMemories(from.id);
            await ctx.answerCallbackQuery({ text: `Forgot ${n} things 🫧` });
            await editFromCallback(app, ctx, memoryScreen([]));
          } else if (a1 === 'wipe') {
            await ctx.answerCallbackQuery();
            await editFromCallback(app, ctx, confirmWipeScreen('memories'));
          }
          return;
        }
        case 'rem': {
          const id = Number(a2);
          if (a1 === 'cancel') {
            app.store.cancelReminder(from.id, id);
            await ctx.answerCallbackQuery({ text: 'Reminder cancelled' });
            await editFromCallback(app, ctx, remindersScreen(app.store.pendingReminders(from.id)));
          } else if (a1 === 'snooze') {
            const mins = Math.min(1440, Math.max(1, Number(a3) || 10));
            const chat = ctx.chat;
            const orig = ctx.callbackQuery.message as Message | undefined;
            const prev = app.store.getReminder(id);
            if (!chat || !prev) return ctx.answerCallbackQuery({ text: 'That reminder is gone 🙈' });
            if (prev.user_id !== from.id) return ctx.answerCallbackQuery({ text: 'That\'s not your reminder 🙂' });
            app.store.addReminder({ userId: from.id, chatId: chat.id, threadId: prev.thread_id, text: prev.text, dueAt: Date.now() + mins * 60_000 });
            await ctx.answerCallbackQuery({ text: `💤 Okay, ${mins} more minutes` });
            if (orig) await app.api.editMessageReplyMarkup(chat.id, orig.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
          } else if (a1 === 'done') {
            await ctx.answerCallbackQuery({ text: 'Молодец! ✅' });
            const orig = ctx.callbackQuery.message;
            if (orig && ctx.chat) await app.api.editMessageReplyMarkup(ctx.chat.id, orig.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
          }
          return;
        }
        case 'forget': {
          if (a1 === 'yes') {
            app.store.deleteUserData(from.id);
            await ctx.answerCallbackQuery({ text: 'Everything deleted.' });
            await editFromCallback(app, ctx, { blocks: [{ type: 'paragraph', text: 'Done — I deleted everything about you. If you ever come back, we start fresh. Пока… 🥺' }] });
          }
          return;
        }
        case 'rg':
        case 'deep': {
          const reply = app.store.getReply(a1 ?? '');
          if (!reply) return ctx.answerCallbackQuery({ text: 'This message is too old to redo 🙈' });
          if (reply.user_id !== from.id && !isAdmin(from.id, cfg)) return ctx.answerCallbackQuery({ text: 'Only the person who asked can do that 😤' });
          if (queue.isBusy(reply.conv)) return ctx.answerCallbackQuery({ text: 'Wait, I\'m still talking! 😤' });
          const latest = app.store.lastAssistantMessage(reply.conv);
          if (!latest || (reply.message_id !== null && latest.tg_message_id !== reply.message_id)) {
            return ctx.answerCallbackQuery({ text: 'I can only redo my latest message 🙈' });
          }
          app.store.deleteMessage(latest.id);
          await ctx.answerCallbackQuery({ text: head === 'deep' ? '🧠 Thinking harder…' : '🔄 Let me try again…' });
          queue.push(reply.conv, {
            kind: reply.chat_id !== null && reply.chat_id < 0 ? 'group' : 'private',
            from,
            chatId: reply.chat_id,
            threadId: reply.thread_id ?? undefined,
            conv: reply.conv,
            mode: head === 'deep' ? 'deep' : 'regenerate',
            reply,
            persistUser: false,
            chatTitle: ctx.chat && 'title' in ctx.chat ? ctx.chat.title : undefined,
          });
          return;
        }
        case 'tts': {
          const reply = app.store.getReply(a1 ?? '');
          if (!reply || reply.chat_id === null) return ctx.answerCallbackQuery({ text: 'This message is too old 🙈' });
          await ctx.answerCallbackQuery({ text: '🎙 Recording…' });
          const chatId = reply.chat_id;
          void (async () => {
            try {
              const ok = await sendVoiceReply(app, chatId, reply.text, { threadId: reply.thread_id ?? undefined, replyTo: reply.message_id ?? undefined, userId: from.id });
              if (!ok) await app.api.sendMessage(chatId, lines.voiceLimit(), { message_thread_id: reply.thread_id ?? undefined });
            } catch (err) {
              log.warn(`tts failed: ${(err as Error).message}`);
              await app.api.sendMessage(chatId, 'My voice isn\'t working right now 😣', { message_thread_id: reply.thread_id ?? undefined }).catch(() => undefined);
            }
          })();
          return;
        }
        case 'adm': {
          if (!isAdmin(from.id, cfg)) return ctx.answerCallbackQuery();
          if (a1 === 'maint') {
            const on = !isMaintenance(app);
            app.store.setKv('maintenance', on ? '1' : '0');
            app.flags.maintenance = on;
          }
          await ctx.answerCallbackQuery({ text: 'Updated' });
          const { collectStats } = await import('./admin.js');
          const { adminScreen } = await import('./screens.js');
          await editFromCallback(app, ctx, adminScreen(collectStats(app, queue as ConvQueue<unknown>)));
          return;
        }
        default:
          await ctx.answerCallbackQuery();
      }
    } catch (err) {
      log.warn(`callback ${data} failed: ${tgDescription(err)}`);
      await ctx.answerCallbackQuery({ text: 'Oops, something went wrong 🙈' }).catch(() => undefined);
    }
  });

  // ------------------------------------------------------------ inline mode

  bot.on('inline_query', async (ctx) => {
    const q = ctx.inlineQuery.query.trim();
    const rich = app.renderer.useRich(app.store.getUser(ctx.from.id)?.settings.classic);
    const footer = { inline_keyboard: [[urlBtn('💬 Chat with Alya', `https://t.me/${app.me.username}?start=inline`)]] };
    const mood = dailyMood(new Date());
    const moodMd = `**Alya's mood today:** ${mood.emoji} ${mood.description}\n\n_— from Saint Petersburg with love ❄️_`;
    const results = [];
    if (q) {
      const md = `💭 _${ctx.from.first_name.replace(/[_*]/g, '')} asked:_ ${truncate(q.replace(/[_*`|]/g, ''), 200)}\n\n_Alya is thinking…_`;
      results.push({
        type: 'article' as const,
        id: `ask:${shortId()}`,
        title: '✨ Ask Alya',
        description: truncate(q, 120),
        input_message_content: rich ? { rich_message: { markdown: md } } : { message_text: `💭 ${truncate(q, 200)}\n\nAlya is thinking…` },
        reply_markup: footer,
      });
    }
    results.push({
      type: 'article' as const,
      id: `mood:${shortId()}`,
      title: `${mood.emoji} Alya's mood today`,
      description: mood.description,
      input_message_content: rich ? { rich_message: { markdown: moodMd } } : { message_text: `Alya's mood today: ${mood.emoji} ${mood.description}` },
      reply_markup: footer,
    });
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch((err) => log.warn(`inline answer failed: ${tgDescription(err)}`));
  });

  bot.on('chosen_inline_result', (ctx) => {
    const r = ctx.chosenInlineResult;
    if (!r.result_id.startsWith('ask:') || !r.inline_message_id || !r.query.trim()) return;
    if (!flood.hit(`u:${r.from.id}`)) return;
    queue.push(`inline:${r.inline_message_id}`, {
      kind: 'inline',
      from: r.from,
      chatId: null,
      conv: `inline:${r.from.id}`,
      incoming: { text: r.query.trim(), repliedToBot: false },
      mode: 'normal',
      persistUser: false,
      inlineMessageId: r.inline_message_id,
    });
  });

  // ------------------------------------------------------------ guest mode (Bot API 10.0)

  bot.on('guest_message', (ctx) => {
    const msg = ctx.update.guest_message!;
    const gm = msg as Message & { guest_query_id?: string; guest_bot_caller_user?: User; guest_bot_caller_chat?: { id: number; title?: string } };
    const caller = gm.guest_bot_caller_user ?? msg.from;
    if (!gm.guest_query_id || !caller) return;
    if (caller.id && !flood.hit(`u:${caller.id}`)) return;
    app.store.upsertUser({ id: caller.id, first_name: caller.first_name, username: caller.username, language_code: caller.language_code });
    const incoming = extractIncoming(msg, app.me.id, app.me.username);
    queue.push(`guest:${gm.guest_query_id}`, {
      kind: 'guest',
      from: caller,
      chatId: null,
      chatTitle: gm.guest_bot_caller_chat?.title,
      conv: `guest:${caller.id}`,
      incoming: incoming.text || incoming.media || incoming.replyContext ? incoming : { ...incoming, text: '(they mentioned you without a question — say hi)' },
      mode: 'normal',
      persistUser: true,
      guestQueryId: gm.guest_query_id,
    });
  });

  // ------------------------------------------------------------ membership, reactions, edits

  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    const status = upd.new_chat_member.status;
    if (upd.chat.type === 'private') {
      app.store.setUserField(upd.from.id, 'blocked', status === 'kicked' ? 1 : 0);
      return;
    }
    if (status === 'member' || status === 'administrator') {
      if (upd.old_chat_member.status === 'left' || upd.old_chat_member.status === 'kicked') {
        await app.renderer.sendScreen(upd.chat.id, groupWelcomeScreen(app.me), {}).catch(() => undefined);
      }
    } else if (status === 'left' || status === 'kicked') {
      app.store.setChatActive(upd.chat.id, false);
    }
  });

  bot.on('message_reaction', (ctx) => {
    const r = ctx.messageReaction;
    const userId = r.user?.id;
    if (!userId) return;
    const added = r.new_reaction.filter((x): x is ReactionTypeEmoji => x.type === 'emoji').map((x) => x.emoji);
    const key = `${r.chat.id}:${r.message_id}:${userId}`;
    if (added.some((e) => POSITIVE_REACTIONS.has(e)) && !reactedTo.has(key)) {
      reactedTo.add(key);
      if (reactedTo.size > 20_000) reactedTo.clear();
      app.store.addBond(userId, 1);
      app.store.incStat('reactions_positive');
    } else if (added.includes('👎')) {
      app.store.incStat('reactions_negative');
    }
  });

  bot.on('edited_message:text', (ctx) => {
    const m = ctx.editedMessage;
    app.store.updateMessageByTgId(convOf(m), m.message_id, stripMention(m.text, app.me.username));
  });

  // Service messages: private-chat topics created by the user.
  bot.on('message:forum_topic_created', (ctx) => {
    const m = ctx.msg;
    if (m.chat.type !== 'private' || !m.message_thread_id) return;
    const implicit = (m.forum_topic_created as { is_name_implicit?: boolean }).is_name_implicit === true;
    app.store.upsertTopic(m.chat.id, m.message_thread_id, m.forum_topic_created.name, !implicit);
  });

  // ------------------------------------------------------------ messages

  bot.on('message', async (ctx) => {
    const msg = ctx.msg;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    if (msg.forum_topic_created || msg.new_chat_members || msg.left_chat_member || msg.pinned_message || msg.chat_shared || msg.users_shared) return;
    if (msg.text?.startsWith('/')) return; // unknown command
    const kind = kindOf(ctx);
    const user = app.store.getUser(from.id)!;

    // Pending force-reply prompts (nickname, timezone, imagine, quiz)
    const ask = pending.get(from.id);
    if (ask && ask.chatId === msg.chat.id && Date.now() < ask.expires && msg.text && (kind === 'private' || msg.reply_to_message?.message_id === ask.messageId)) {
      pending.delete(from.id);
      const input = stripMention(msg.text, app.me.username);
      if (ask.kind === 'nickname') {
        const nick = /^(reset|none|-)$/i.test(input) ? undefined : truncate(input.replace(/[\n*_`|[\]]/g, ''), 32);
        app.store.updateUserSettings(from.id, { nickname: nick });
        await ctx.reply(nick ? `Okay, ${nick} it is ✨` : 'Okay, back to your name 🙂');
      } else if (ask.kind === 'timezone') {
        void (async () => {
          const tz = await resolveTimezone(app, input);
          if (tz) {
            app.store.setUserField(from.id, 'timezone', tz);
            await ctx.reply(`🌍 Got it — ${tz}. Now my reminders use your time ✨`);
          } else {
            await ctx.reply('Hmm, I don\'t know that place 🤔 Try a big city nearby or something like Asia/Kolkata.');
          }
        })().catch(() => undefined);
      } else if (ask.kind === 'imagine') {
        void drawImage(app, ctx, input);
      } else if (ask.kind === 'quiz') {
        void generateQuiz(app, msg.chat.id, input, threadOf(msg)).catch(async () => ctx.reply('My quiz brain froze 🥶 Try another topic?').catch(() => undefined));
      }
      return;
    }

    const incoming = extractIncoming(msg, app.me.id, app.me.username);
    const conv = convOf(msg);

    if (kind === 'group') {
      const chat = app.store.getChat(msg.chat.id);
      const text = msg.text ?? msg.caption ?? '';
      const mentioned =
        (msg.entities ?? msg.caption_entities ?? []).some((e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${app.me.username.toLowerCase()}`) ||
        text.toLowerCase().includes(`@${app.me.username.toLowerCase()}`);
      const byName = chat?.settings.replyMode !== 'mention' && /(^|[^\p{L}])(alya|аля|алья)([^\p{L}]|$)/iu.test(text);
      const addressed = mentioned || incoming.repliedToBot || byName;
      if (!addressed) {
        if (text && !incoming.media) {
          app.store.addMessage({ conv, role: 'user', content: truncate(text, 1000), name: from.first_name, userId: from.id, tgMessageId: msg.message_id });
        }
        return;
      }
      if (!flood.hit(`u:${from.id}`)) {
        if (warned.hit(`w:${from.id}`)) await ctx.reply(lines.slowDown(), { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => undefined);
        return;
      }
      if (chat?.settings.reactions !== false && user.settings.reactions) {
        const emoji = pickReaction(text);
        if (emoji) void ctx.api.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => undefined);
      }
      queue.push(conv, {
        kind: 'group',
        from,
        chatId: msg.chat.id,
        chatTitle: 'title' in msg.chat ? msg.chat.title : undefined,
        threadId: threadOf(msg),
        conv,
        incoming: incoming.text || incoming.media ? incoming : { ...incoming, text: '(they called you without saying anything else)' },
        userMessageId: msg.message_id,
        mode: 'normal',
        persistUser: true,
      });
      return;
    }

    // private
    if (!flood.hit(`u:${from.id}`)) {
      if (warned.hit(`w:${from.id}`)) await ctx.reply(lines.slowDown()).catch(() => undefined);
      return;
    }
    const today = dayKey(new Date(), cfg.defaultTimezone);
    if (cfg.dailyMessageLimit > 0 && !isAdmin(from.id, cfg)) {
      const used = app.store.incUsage(today, from.id, 'msg');
      if (used > cfg.dailyMessageLimit) {
        if (used === cfg.dailyMessageLimit + 1) await ctx.reply(lines.dailyLimit()).catch(() => undefined);
        return;
      }
    }
    const yesterday = dayKey(new Date(Date.now() - 86_400_000), cfg.defaultTimezone);
    const act = app.store.touchActivity(from.id, today, yesterday);
    const threadId = threadOf(msg);
    if (threadId && !app.store.getTopic(msg.chat.id, threadId)) app.store.upsertTopic(msg.chat.id, threadId, null, true);
    if (user.settings.reactions) {
      const emoji = pickReaction(incoming.text);
      if (emoji) void ctx.api.setMessageReaction(msg.chat.id, msg.message_id, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => undefined);
    }
    const effect = chooseEffect(incoming.text, user.bond, act.milestone);
    if (act.milestone) app.store.addBond(from.id, 2);
    const accepted = queue.push(conv, {
      kind: 'private',
      from,
      chatId: msg.chat.id,
      threadId,
      conv,
      incoming,
      userMessageId: msg.message_id,
      mode: 'normal',
      persistUser: true,
      effect,
    });
    if (!accepted) await ctx.reply(lines.slowDown()).catch(() => undefined);
  });
}

export function isBlocked(err: unknown): boolean {
  return isBlockedByUser(err);
}
