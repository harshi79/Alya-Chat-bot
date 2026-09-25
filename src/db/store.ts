/**
 * Persistence on the built-in node:sqlite (zero native dependencies).
 * One Store instance per process; all methods are synchronous and fast.
 */
import '../util/quiet.js';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { shortId } from '../util/text.js';
import type { ReplyLanguage } from '../persona/language.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- types

export type VoiceMode = 'off' | 'auto' | 'always';
export type BrainMode = 'auto' | 'fast' | 'deep';

export interface UserSettings {
  replyLanguage: ReplyLanguage;
  langChosen: boolean;
  voice: VoiceMode;
  brain: BrainMode;
  showThoughts: boolean;
  classic: boolean;
  effects: boolean;
  reactions: boolean;
  nickname?: string;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  replyLanguage: 'hinglish',
  langChosen: false,
  voice: 'auto',
  brain: 'auto',
  showThoughts: false,
  classic: false,
  effects: true,
  reactions: true,
};

export type ReplyMode = 'mention' | 'name';

export interface ChatSettings {
  replyMode: ReplyMode;
  reactions: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { replyMode: 'name', reactions: true };

export interface UserRow {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  created_at: number;
  last_seen: number;
  messages: number;
  bond: number;
  streak: number;
  best_streak: number;
  last_day: string | null;
  days_talked: number;
  timezone: string | null;
  banned: number;
  blocked: number;
  referred_by: number | null;
  settings: UserSettings;
}

export interface ChatRow {
  id: number;
  type: string;
  title: string | null;
  created_at: number;
  active: number;
  settings: ChatSettings;
}

export interface MessageRow {
  id: number;
  conv: string;
  role: 'user' | 'assistant';
  name: string | null;
  user_id: number | null;
  content: string;
  tg_message_id: number | null;
  created_at: number;
}

export interface MemoryRow {
  id: number;
  user_id: number;
  fact: string;
  created_at: number;
  source: string | null;
}

export interface ReminderRow {
  id: number;
  user_id: number;
  chat_id: number;
  thread_id: number | null;
  text: string;
  due_at: number;
  created_at: number;
  status: string;
}

export interface ReplyRecord {
  id: string;
  chat_id: number | null;
  thread_id: number | null;
  user_id: number;
  message_id: number | null;
  inline_message_id: string | null;
  conv: string;
  prompt: string;
  text: string;
  created_at: number;
}

export interface TopicRow {
  chat_id: number;
  thread_id: number;
  title: string | null;
  titled: number;
  created_at: number;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT,
      username TEXT,
      language_code TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      bond INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      last_day TEXT,
      days_talked INTEGER NOT NULL DEFAULT 0,
      timezone TEXT,
      banned INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      referred_by INTEGER,
      settings TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      settings TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT,
      user_id INTEGER,
      content TEXT NOT NULL,
      tg_message_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv, id);
    CREATE TABLE IF NOT EXISTS summaries (
      conv TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      upto_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      fact TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id);
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      text TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
    CREATE TABLE IF NOT EXISTS usage (
      day TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY,
      chat_id INTEGER,
      thread_id INTEGER,
      user_id INTEGER NOT NULL,
      message_id INTEGER,
      inline_message_id TEXT,
      conv TEXT NOT NULL,
      prompt TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_replies_created ON replies(created_at);
    CREATE TABLE IF NOT EXISTS topics (
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      title TEXT,
      titled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
};

type Row = Record<string, SQLInputValue>;

function now(): number {
  return Date.now();
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return { ...fallback };
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? { ...fallback, ...(v as object) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync: Db } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new Db(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
    let version = row ? Number(row.value) : 0;
    while (version < SCHEMA_VERSION) {
      version += 1;
      const sql = MIGRATIONS[version];
      if (!sql) throw new Error(`missing migration ${version}`);
      this.tx(() => {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(version));
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ users

  private toUser(r: Row): UserRow {
    return {
      id: Number(r.id),
      first_name: String(r.first_name ?? ''),
      last_name: (r.last_name as string | null) ?? null,
      username: (r.username as string | null) ?? null,
      language_code: (r.language_code as string | null) ?? null,
      created_at: Number(r.created_at),
      last_seen: Number(r.last_seen),
      messages: Number(r.messages),
      bond: Number(r.bond),
      streak: Number(r.streak),
      best_streak: Number(r.best_streak),
      last_day: (r.last_day as string | null) ?? null,
      days_talked: Number(r.days_talked),
      timezone: (r.timezone as string | null) ?? null,
      banned: Number(r.banned),
      blocked: Number(r.blocked),
      referred_by: r.referred_by === null || r.referred_by === undefined ? null : Number(r.referred_by),
      settings: parseJson<UserSettings>(r.settings, DEFAULT_USER_SETTINGS),
    };
  }

  getUser(id: number): UserRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toUser(r) : undefined;
  }

  /** Insert or refresh profile fields; returns [user, isNew]. */
  upsertUser(u: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }): [UserRow, boolean] {
    const existing = this.getUser(u.id);
    const t = now();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO users (id, first_name, last_name, username, language_code, created_at, last_seen, settings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(u.id, u.first_name ?? '', u.last_name ?? null, u.username ?? null, u.language_code ?? null, t, t, JSON.stringify(DEFAULT_USER_SETTINGS));
      return [this.getUser(u.id)!, true];
    }
    this.db
      .prepare(
        `UPDATE users SET first_name = ?, last_name = ?, username = ?, language_code = COALESCE(?, language_code),
         last_seen = ?, blocked = 0 WHERE id = ?`,
      )
      .run(u.first_name ?? existing.first_name, u.last_name ?? null, u.username ?? null, u.language_code ?? null, t, u.id);
    return [this.getUser(u.id)!, false];
  }

  updateUserSettings(id: number, patch: Partial<UserSettings>): UserSettings {
    const user = this.getUser(id);
    const next: UserSettings = { ...(user?.settings ?? DEFAULT_USER_SETTINGS), ...patch };
    this.db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  setUserField(id: number, field: 'timezone' | 'banned' | 'blocked' | 'referred_by' | 'bond', value: SQLInputValue): void {
    const allowed = new Set(['timezone', 'banned', 'blocked', 'referred_by', 'bond']);
    if (!allowed.has(field)) throw new Error(`bad field ${field}`);
    this.db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, id);
  }

  /** Called once per incoming user message: counters, streak, bond. Returns streak info. */
  touchActivity(id: number, today: string, yesterday: string): { streak: number; newDay: boolean; milestone: boolean } {
    const u = this.getUser(id);
    if (!u) return { streak: 0, newDay: false, milestone: false };
    let streak = u.streak;
    let newDay = false;
    let daysTalked = u.days_talked;
    let bond = u.bond;
    if (u.last_day !== today) {
      newDay = true;
      daysTalked += 1;
      streak = u.last_day === yesterday ? streak + 1 : 1;
      bond += 3; // showing up on a new day matters most
    }
    // small bond gain per message, capped per day by the natural rate
    if (u.messages % 10 === 9) bond += 1;
    bond = Math.min(100, bond);
    const best = Math.max(u.best_streak, streak);
    this.db
      .prepare(
        'UPDATE users SET messages = messages + 1, last_day = ?, streak = ?, best_streak = ?, days_talked = ?, bond = ?, last_seen = ? WHERE id = ?',
      )
      .run(today, streak, best, daysTalked, bond, now(), id);
    const milestone = newDay && [3, 7, 14, 30, 50, 100, 200, 365].includes(streak);
    return { streak, newDay, milestone };
  }

  addBond(id: number, delta: number): number {
    this.db.prepare('UPDATE users SET bond = MAX(0, MIN(100, bond + ?)) WHERE id = ?').run(delta, id);
    return this.getUser(id)?.bond ?? 0;
  }

  listActiveUserIds(): number[] {
    const rows = this.db.prepare('SELECT id FROM users WHERE banned = 0 AND blocked = 0 ORDER BY id').all() as Row[];
    return rows.map((r) => Number(r.id));
  }

  countUsers(): { total: number; active24h: number; active7d: number; banned: number; blocked: number } {
    const t = now();
    const q = (sql: string, ...p: SQLInputValue[]) => Number((this.db.prepare(sql).get(...p) as Row).n);
    return {
      total: q('SELECT COUNT(*) n FROM users'),
      active24h: q('SELECT COUNT(*) n FROM users WHERE last_seen >= ?', t - 86_400_000),
      active7d: q('SELECT COUNT(*) n FROM users WHERE last_seen >= ?', t - 7 * 86_400_000),
      banned: q('SELECT COUNT(*) n FROM users WHERE banned = 1'),
      blocked: q('SELECT COUNT(*) n FROM users WHERE blocked = 1'),
    };
  }

  topUsers(limit = 5): UserRow[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY messages DESC LIMIT ?').all(limit) as Row[]).map((r) => this.toUser(r));
  }

  deleteUserData(id: number): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM reminders WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM replies WHERE user_id = ?').run(id);
      this.db.prepare("DELETE FROM messages WHERE conv LIKE ?").run(`${id}:%`);
      this.db.prepare("DELETE FROM summaries WHERE conv LIKE ?").run(`${id}:%`);
      this.db.prepare('DELETE FROM usage WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM topics WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
  }

  // ------------------------------------------------------------ chats

  private toChat(r: Row): ChatRow {
    return {
      id: Number(r.id),
      type: String(r.type),
      title: (r.title as string | null) ?? null,
      created_at: Number(r.created_at),
      active: Number(r.active),
      settings: parseJson<ChatSettings>(r.settings, DEFAULT_CHAT_SETTINGS),
    };
  }

  getChat(id: number): ChatRow | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toChat(r) : undefined;
  }

  upsertChat(c: { id: number; type: string; title?: string }): ChatRow {
    this.db
      .prepare(
        `INSERT INTO chats (id, type, title, created_at, settings) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = COALESCE(excluded.title, chats.title), active = 1`,
      )
      .run(c.id, c.type, c.title ?? null, now(), JSON.stringify(DEFAULT_CHAT_SETTINGS));
    return this.getChat(c.id)!;
  }

  setChatActive(id: number, active: boolean): void {
    this.db.prepare('UPDATE chats SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }

  updateChatSettings(id: number, patch: Partial<ChatSettings>): ChatSettings {
    const chat = this.getChat(id);
    const next = { ...(chat?.settings ?? DEFAULT_CHAT_SETTINGS), ...patch };
    this.db.prepare('UPDATE chats SET settings = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  countGroups(): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM chats WHERE type IN ('group','supergroup') AND active = 1").get() as Row).n);
  }

  // ------------------------------------------------------------ messages (history)

  private toMessage(r: Row): MessageRow {
    return {
      id: Number(r.id),
      conv: String(r.conv),
      role: r.role === 'assistant' ? 'assistant' : 'user',
      name: (r.name as string | null) ?? null,
      user_id: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
      content: String(r.content),
      tg_message_id: r.tg_message_id === null || r.tg_message_id === undefined ? null : Number(r.tg_message_id),
      created_at: Number(r.created_at),
    };
  }

  addMessage(m: { conv: string; role: 'user' | 'assistant'; content: string; name?: string | null; userId?: number | null; tgMessageId?: number | null }): number {
    const r = this.db
      .prepare('INSERT INTO messages (conv, role, name, user_id, content, tg_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.conv, m.role, m.name ?? null, m.userId ?? null, m.content, m.tgMessageId ?? null, now());
    return Number(r.lastInsertRowid);
  }

  updateMessageContent(id: number, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  }

  updateMessageByTgId(conv: string, tgMessageId: number, content: string): boolean {
    const r = this.db.prepare('UPDATE messages SET content = ? WHERE conv = ? AND tg_message_id = ? AND role = ?').run(content, conv, tgMessageId, 'user');
    return Number(r.changes) > 0;
  }

  setMessageTgId(id: number, tgMessageId: number): void {
    this.db.prepare('UPDATE messages SET tg_message_id = ? WHERE id = ?').run(tgMessageId, id);
  }

  deleteMessage(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  /** Most recent `limit` messages, oldest first. */
  recentMessages(conv: string, limit: number): MessageRow[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conv = ? ORDER BY id DESC LIMIT ?').all(conv, limit) as Row[];
    return rows.map((r) => this.toMessage(r)).reverse();
  }

  messagesBetween(conv: string, afterId: number, beforeIdExclusive: number): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conv = ? AND id > ? AND id < ? ORDER BY id ASC')
      .all(conv, afterId, beforeIdExclusive) as Row[];
    return rows.map((r) => this.toMessage(r));
  }

  countMessages(conv: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) n FROM messages WHERE conv = ?').get(conv) as Row).n);
  }

  clearConversation(conv: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM messages WHERE conv = ?').run(conv);
      this.db.prepare('DELETE FROM summaries WHERE conv = ?').run(conv);
    });
  }

  lastAssistantMessage(conv: string): MessageRow | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE conv = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(conv) as Row | undefined;
    return r ? this.toMessage(r) : undefined;
  }

  pruneOldMessages(keepPerConv: number): number {
    const r = this.db
      .prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY conv ORDER BY id DESC) AS rn FROM messages
           ) WHERE rn > ?
         )`,
      )
      .run(keepPerConv);
    return Number(r.changes);
  }

  // ------------------------------------------------------------ summaries

  getSummary(conv: string): { summary: string; upto_id: number } | undefined {
    const r = this.db.prepare('SELECT summary, upto_id FROM summaries WHERE conv = ?').get(conv) as Row | undefined;
    return r ? { summary: String(r.summary), upto_id: Number(r.upto_id) } : undefined;
  }

  setSummary(conv: string, summary: string, uptoId: number): void {
    this.db
      .prepare(
        `INSERT INTO summaries (conv, summary, upto_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(conv) DO UPDATE SET summary = excluded.summary, upto_id = excluded.upto_id, updated_at = excluded.updated_at`,
      )
      .run(conv, summary, uptoId, now());
  }

  // ------------------------------------------------------------ memories

  listMemories(userId: number): MemoryRow[] {
    return (this.db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id ASC').all(userId) as Row[]).map((r) => ({
      id: Number(r.id),
      user_id: Number(r.user_id),
      fact: String(r.fact),
      created_at: Number(r.created_at),
      source: (r.source as string | null) ?? null,
    }));
  }

  /** Adds a fact unless a near-duplicate exists; evicts the oldest past `cap`. Returns the new id or null. */
  addMemory(userId: number, fact: string, source: string, cap: number): number | null {
    const clean = fact.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (clean.length < 3) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').trim();
    const n = norm(clean);
    const existing = this.listMemories(userId);
    for (const m of existing) {
      const e = norm(m.fact);
      if (e === n || (e.length > 12 && (e.includes(n) || n.includes(e)))) {
        if (n.length > e.length) this.db.prepare('UPDATE memories SET fact = ? WHERE id = ?').run(clean, m.id);
        return null;
      }
    }
    const r = this.db.prepare('INSERT INTO memories (user_id, fact, created_at, source) VALUES (?, ?, ?, ?)').run(userId, clean, now(), source);
    const overflow = existing.length + 1 - cap;
    if (overflow > 0) {
      this.db
        .prepare('DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE user_id = ? ORDER BY id ASC LIMIT ?)')
        .run(userId, overflow);
    }
    return Number(r.lastInsertRowid);
  }

  deleteMemory(userId: number, id: number): boolean {
    return Number(this.db.prepare('DELETE FROM memories WHERE user_id = ? AND id = ?').run(userId, id).changes) > 0;
  }

  /** Delete memories containing `query` (case-insensitive). Returns count. */
  forgetMatching(userId: number, query: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const victims = this.listMemories(userId).filter((m) => m.fact.toLowerCase().includes(q));
    for (const v of victims) this.deleteMemory(userId, v.id);
    return victims.length;
  }

  clearMemories(userId: number): number {
    return Number(this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId).changes);
  }

  // ------------------------------------------------------------ reminders

  private toReminder(r: Row): ReminderRow {
    return {
      id: Number(r.id),
      user_id: Number(r.user_id),
      chat_id: Number(r.chat_id),
      thread_id: r.thread_id === null || r.thread_id === undefined ? null : Number(r.thread_id),
      text: String(r.text),
      due_at: Number(r.due_at),
      created_at: Number(r.created_at),
      status: String(r.status),
    };
  }

  addReminder(r: { userId: number; chatId: number; threadId?: number | null; text: string; dueAt: number }): number {
    const res = this.db
      .prepare('INSERT INTO reminders (user_id, chat_id, thread_id, text, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.userId, r.chatId, r.threadId ?? null, r.text.slice(0, 500), r.dueAt, now());
    return Number(res.lastInsertRowid);
  }

  getReminder(id: number): ReminderRow | undefined {
    const r = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toReminder(r) : undefined;
  }

  dueReminders(at: number, limit = 50): ReminderRow[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?").all(at, limit) as Row[]).map((r) =>
      this.toReminder(r),
    );
  }

  pendingReminders(userId: number): ReminderRow[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY due_at").all(userId) as Row[]).map((r) =>
      this.toReminder(r),
    );
  }

  setReminderStatus(id: number, status: 'pending' | 'sent' | 'failed' | 'cancelled'): void {
    this.db.prepare('UPDATE reminders SET status = ? WHERE id = ?').run(status, id);
  }

  cancelReminder(userId: number, id: number): boolean {
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(id, userId).changes) > 0;
  }

  // ------------------------------------------------------------ usage & stats

  incUsage(day: string, userId: number, kind: string, by = 1): number {
    this.db
      .prepare(
        `INSERT INTO usage (day, user_id, kind, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, user_id, kind) DO UPDATE SET count = count + excluded.count`,
      )
      .run(day, userId, kind, by);
    return this.getUsage(day, userId, kind);
  }

  getUsage(day: string, userId: number, kind: string): number {
    const r = this.db.prepare('SELECT count FROM usage WHERE day = ? AND user_id = ? AND kind = ?').get(day, userId, kind) as Row | undefined;
    return r ? Number(r.count) : 0;
  }

  usageTotals(day: string): Record<string, number> {
    const rows = this.db.prepare('SELECT kind, SUM(count) c FROM usage WHERE day = ? GROUP BY kind').all(day) as Row[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.kind)] = Number(r.c);
    return out;
  }

  pruneUsage(beforeDay: string): void {
    this.db.prepare('DELETE FROM usage WHERE day < ?').run(beforeDay);
  }

  incStat(key: string, by = 1): void {
    this.db.prepare('INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value').run(key, by);
  }

  getStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT key, value FROM stats').all() as Row[]) out[String(r.key)] = Number(r.value);
    return out;
  }

  // ------------------------------------------------------------ reply registry (buttons under Alya's replies)

  saveReply(r: Omit<ReplyRecord, 'id' | 'created_at'>): string {
    const id = shortId() + shortId().slice(0, 2);
    this.db
      .prepare(
        `INSERT INTO replies (id, chat_id, thread_id, user_id, message_id, inline_message_id, conv, prompt, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, r.chat_id, r.thread_id, r.user_id, r.message_id, r.inline_message_id, r.conv, r.prompt.slice(0, 8000), r.text.slice(0, 32000), now());
    return id;
  }

  getReply(id: string): ReplyRecord | undefined {
    const r = this.db.prepare('SELECT * FROM replies WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      chat_id: r.chat_id === null ? null : Number(r.chat_id),
      thread_id: r.thread_id === null ? null : Number(r.thread_id),
      user_id: Number(r.user_id),
      message_id: r.message_id === null ? null : Number(r.message_id),
      inline_message_id: (r.inline_message_id as string | null) ?? null,
      conv: String(r.conv),
      prompt: String(r.prompt),
      text: String(r.text),
      created_at: Number(r.created_at),
    };
  }

  updateReply(id: string, patch: { message_id?: number | null; text?: string }): void {
    if (patch.message_id !== undefined) this.db.prepare('UPDATE replies SET message_id = ? WHERE id = ?').run(patch.message_id, id);
    if (patch.text !== undefined) this.db.prepare('UPDATE replies SET text = ? WHERE id = ?').run(patch.text.slice(0, 32000), id);
  }

  pruneReplies(olderThanMs: number): void {
    this.db.prepare('DELETE FROM replies WHERE created_at < ?').run(now() - olderThanMs);
  }

  // ------------------------------------------------------------ private-chat topics

  getTopic(chatId: number, threadId: number): TopicRow | undefined {
    const r = this.db.prepare('SELECT * FROM topics WHERE chat_id = ? AND thread_id = ?').get(chatId, threadId) as Row | undefined;
    return r
      ? { chat_id: Number(r.chat_id), thread_id: Number(r.thread_id), title: (r.title as string | null) ?? null, titled: Number(r.titled), created_at: Number(r.created_at) }
      : undefined;
  }

  upsertTopic(chatId: number, threadId: number, title: string | null, titled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO topics (chat_id, thread_id, title, titled, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_id) DO UPDATE SET title = COALESCE(excluded.title, topics.title), titled = MAX(topics.titled, excluded.titled)`,
      )
      .run(chatId, threadId, title, titled ? 1 : 0, now());
  }

  // ------------------------------------------------------------ kv

  getKv(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  delKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

export function convKey(chatId: number, threadId?: number | null): string {
  return `${chatId}:${threadId ?? 0}`;
}
