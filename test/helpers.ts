/** Test harness: real bot + mock Telegram + mock NVIDIA, in-memory database. */
import type { Update, UserFromGetMe } from 'grammy/types';
import { buildBot, type BuiltBot } from '../src/bot/bot.js';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { MockNvidia } from './mock-nvidia.js';
import { MockTelegram } from './mock-telegram.js';

export const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Alya',
  username: 'alya_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: true,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export interface Harness extends BuiltBot {
  tg: MockTelegram;
  nv: MockNvidia;
  cfg: Config;
  send(update: Partial<Update>): Promise<void>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

let updateId = 1;

export async function harness(overrides: Partial<Config> = {}, botInfo: Partial<UserFromGetMe> = {}): Promise<Harness> {
  const tg = new MockTelegram();
  const nv = new MockNvidia();
  await tg.start();
  await nv.start();
  const cfg: Config = {
    ...loadConfig(),
    botToken: '123:TEST',
    apiRoot: tg.apiRoot,
    nvidiaKey: 'nvapi-test',
    nvidiaBaseUrl: `${nv.base}/v1`,
    genaiBaseUrl: `${nv.base}/genai`,
    nvcfUrlTemplate: `${nv.base}/nvcf/{id}`,
    ownerId: 1,
    adminIds: [1],
    dbFile: ':memory:',
    streamIntervalMs: 250,
    editIntervalMs: 500,
    nvidiaRpm: 1000,
    dailyMessageLimit: 0,
    userMsgsPerMin: 1000,
    syncCommands: false,
    ...overrides,
  };
  const store = new Store(':memory:');
  const built = await buildBot(cfg, { store, botInfo: { ...BOT_INFO, ...botInfo } as UserFromGetMe });
  const h: Harness = {
    ...built,
    tg,
    nv,
    cfg,
    async send(update) {
      await built.bot.handleUpdate({ update_id: updateId++, ...update } as Update);
    },
    async settle() {
      await new Promise((r) => setTimeout(r, 20));
      await built.queue.idle();
      await new Promise((r) => setTimeout(r, 30));
    },
    async close() {
      built.app.active.abortAll();
      await built.queue.idle();
      store.close();
      await tg.stop();
      await nv.stop();
    },
  };
  return h;
}

const now = () => Math.floor(Date.now() / 1000);

export function privateText(text: string, opts: { userId?: number; firstName?: string; messageId?: number; extra?: Record<string, unknown> } = {}): Partial<Update> {
  const userId = opts.userId ?? 42;
  return {
    message: {
      message_id: opts.messageId ?? Math.floor(Math.random() * 1e6),
      date: now(),
      chat: { id: userId, type: 'private', first_name: opts.firstName ?? 'Rahul' },
      from: { id: userId, is_bot: false, first_name: opts.firstName ?? 'Rahul', language_code: 'en' },
      text,
      ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
      ...(opts.extra ?? {}),
    },
  } as Partial<Update>;
}

export function groupText(text: string, opts: { userId?: number; chatId?: number; extra?: Record<string, unknown>; messageId?: number } = {}): Partial<Update> {
  const userId = opts.userId ?? 42;
  const entities: Array<Record<string, unknown>> = [];
  const mention = text.indexOf('@alya_test_bot');
  if (mention >= 0) entities.push({ type: 'mention', offset: mention, length: '@alya_test_bot'.length });
  if (text.startsWith('/')) entities.push({ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length });
  return {
    message: {
      message_id: opts.messageId ?? Math.floor(Math.random() * 1e6),
      date: now(),
      chat: { id: opts.chatId ?? -100123, type: 'supergroup', title: 'Test Group' },
      from: { id: userId, is_bot: false, first_name: 'Rahul' },
      text,
      entities,
      ...(opts.extra ?? {}),
    },
  } as Partial<Update>;
}
