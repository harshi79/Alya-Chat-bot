/**
 * Tools Alya can call (OpenAI function-calling format, supported by Nemotron 3).
 * Execution is local and synchronous; anything that sends extra messages
 * (images, dice, quizzes) is *deferred* until after the text reply is delivered.
 */
import type { Config } from '../config.js';
import type { ChatKind } from '../persona/alya.js';
import type { Store } from '../db/store.js';
import { isValidTimeZone, unix, zonedWallTimeToUtc } from '../util/time.js';
import { extractJson, type ToolCall, type ToolDef } from './nvidia.js';

export type Deferred =
  | { type: 'image'; prompt: string }
  | { type: 'dice'; emoji: string }
  | { type: 'quiz'; question: string; options: string[]; correct: number[]; explanation?: string };

export interface ToolEnv {
  kind: ChatKind;
  userId: number;
  chatId: number | null;
  threadId?: number;
  timezone: string | null;
  now: Date;
  store: Store;
  cfg: Config;
  canDraw: boolean;
  deferred: Deferred[];
}

export interface ToolOutcome {
  name: string;
  result: Record<string, unknown>;
  /** Markdown appended to the reply (e.g. reminder confirmation with a localized time). */
  note?: string;
  /** Short status line while the tool runs. */
  status?: string;
}

const DICE = ['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'];

export function toolDefs(kind: ChatKind, canDraw: boolean): ToolDef[] {
  const defs: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'remember_fact',
        description: 'Save a lasting fact about the user to long-term memory (name, birthday, pets, likes, goals, important events).',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: 'Short third-person fact, e.g. "Their dog is called Bruno".' } },
          required: ['fact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget_fact',
        description: 'Delete memories about the user that contain the given words.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_timezone',
        description: "Save the user's timezone as an IANA name (e.g. Asia/Kolkata, Europe/Berlin, America/New_York).",
        parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
      },
    },
  ];
  if (kind === 'private' || kind === 'group') {
    defs.push({
      type: 'function',
      function: {
        name: 'set_reminder',
        description: 'Schedule a reminder message to the user. Give either in_minutes (relative) or at_local_time (in the user\'s timezone).',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to remind about, e.g. "call mom".' },
            in_minutes: { type: 'number', description: 'Minutes from now (1 to 525600).' },
            at_local_time: { type: 'string', description: 'Local wall-clock time "YYYY-MM-DDTHH:mm" in the user\'s timezone.' },
          },
          required: ['text'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'roll_dice',
        description: 'Send an animated Telegram dice for games and random decisions.',
        parameters: { type: 'object', properties: { emoji: { type: 'string', enum: DICE } }, required: ['emoji'] },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'create_quiz',
        description: 'Send a quiz poll to the chat.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Up to 300 characters.' },
            options: { type: 'array', items: { type: 'string' }, description: '2 to 10 short answer options.' },
            correct_option_ids: { type: 'array', items: { type: 'integer' }, description: '0-based indexes of the correct options.' },
            explanation: { type: 'string', description: 'Shown after answering (up to 200 characters).' },
          },
          required: ['question', 'options', 'correct_option_ids'],
        },
      },
    });
  }
  if (canDraw) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Draw/generate an image (FLUX). Use a vivid, detailed English prompt. No sexual content, no real people.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
      },
    });
  }
  return defs;
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments?.trim() || '{}';
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return extractJson<Record<string, unknown>>(raw) ?? {};
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function runTool(call: ToolCall, env: ToolEnv): ToolOutcome {
  const name = call.function.name;
  const a = parseArgs(call);
  switch (name) {
    case 'remember_fact': {
      const fact = str(a.fact, 300);
      if (!fact) return { name, result: { ok: false, error: 'empty fact' } };
      const id = env.store.addMemory(env.userId, fact, 'tool', env.cfg.maxMemories);
      return { name, result: { ok: true, saved: id !== null, note: id === null ? 'already known' : 'saved' } };
    }
    case 'forget_fact': {
      const n = env.store.forgetMatching(env.userId, str(a.query, 100));
      return { name, result: { ok: true, deleted: n } };
    }
    case 'set_timezone': {
      const tz = str(a.timezone, 64);
      if (!isValidTimeZone(tz)) return { name, result: { ok: false, error: `unknown timezone "${tz}" — use an IANA name like Asia/Kolkata` } };
      env.store.setUserField(env.userId, 'timezone', tz);
      env.timezone = tz;
      return { name, result: { ok: true, timezone: tz } };
    }
    case 'set_reminder': {
      if (env.chatId === null) return { name, result: { ok: false, error: 'reminders are not available here' } };
      const text = str(a.text, 300) || 'your reminder';
      let due: Date | null = null;
      const mins = typeof a.in_minutes === 'number' ? a.in_minutes : Number.parseFloat(str(a.in_minutes));
      if (Number.isFinite(mins) && mins > 0) {
        due = new Date(env.now.getTime() + Math.min(525_600, mins) * 60_000);
      } else if (str(a.at_local_time)) {
        const tz = env.timezone && isValidTimeZone(env.timezone) ? env.timezone : null;
        if (!tz) return { name, result: { ok: false, error: 'the user timezone is unknown — ask which city they live in, then call set_timezone' } };
        due = zonedWallTimeToUtc(str(a.at_local_time), tz);
      }
      if (!due || !Number.isFinite(due.getTime())) return { name, result: { ok: false, error: 'give in_minutes or at_local_time' } };
      if (due.getTime() < env.now.getTime() + 20_000) return { name, result: { ok: false, error: 'that time is in the past' } };
      if (env.store.pendingReminders(env.userId).length >= 25) return { name, result: { ok: false, error: 'too many pending reminders (25 max)' } };
      const id = env.store.addReminder({ userId: env.userId, chatId: env.chatId, threadId: env.threadId ?? null, text, dueAt: due.getTime() });
      const ts = unix(due);
      return {
        name,
        result: { ok: true, id, due_utc: due.toISOString() },
        note: `⏰ **Reminder set:** ${text.replace(/[*_`|]/g, '')} — ![${due.toISOString().slice(0, 16).replace('T', ' ')} UTC](tg://time?unix=${ts}&format=wDT) (![in a while](tg://time?unix=${ts}&format=r))`,
      };
    }
    case 'roll_dice': {
      const emoji = DICE.includes(str(a.emoji, 4)) ? str(a.emoji, 4) : '🎲';
      env.deferred.push({ type: 'dice', emoji });
      return { name, result: { ok: true, sent: emoji, note: 'the dice animation is sent right after your message; you cannot know the value yet' } };
    }
    case 'create_quiz': {
      const question = str(a.question, 300);
      const options = (Array.isArray(a.options) ? a.options : []).map((o) => str(o, 100)).filter(Boolean).slice(0, 10);
      const correct = (Array.isArray(a.correct_option_ids) ? a.correct_option_ids : [a.correct_option_ids])
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 0 && x < options.length);
      if (!question || options.length < 2 || correct.length === 0) return { name, result: { ok: false, error: 'need a question, 2+ options and a valid correct index' } };
      env.deferred.push({ type: 'quiz', question, options, correct: [...new Set(correct)], explanation: str(a.explanation, 200) || undefined });
      return { name, result: { ok: true, note: 'quiz will be sent right after your message — do not reveal the answer' } };
    }
    case 'generate_image': {
      if (!env.canDraw) return { name, result: { ok: false, error: 'drawing is not available here' } };
      const prompt = str(a.prompt, 1500);
      if (!prompt) return { name, result: { ok: false, error: 'empty prompt' } };
      env.deferred.push({ type: 'image', prompt });
      return { name, result: { ok: true, note: 'the image is being drawn and will be sent right after your message' }, status: '🎨 Drawing…' };
    }
    default:
      return { name, result: { ok: false, error: `unknown tool ${name}` } };
  }
}
