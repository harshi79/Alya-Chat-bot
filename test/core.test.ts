import { describe, expect, it } from 'vitest';
import { makeWav, parseWav, pcmToMp3 } from '../src/ai/audio.js';
import { RateLimiter, WindowCounter } from '../src/ai/limiter.js';
import { extractJson, extractLeakedToolCalls, parseCompletion, ThinkSplitter, type StreamEvent } from '../src/ai/nvidia.js';
import { prepareSpeech, imagePromptProblem } from '../src/ai/services.js';
import { readSse } from '../src/ai/sse.js';
import { runTool, toolDefs, type ToolEnv } from '../src/ai/tools.js';
import { ConvQueue } from '../src/chat/queue.js';
import { actionKeyboard, chooseEffect, chooseThinking, EFFECTS, pickReaction } from '../src/chat/policy.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { buildSystemPrompt } from '../src/persona/alya.js';
import { bondLevel, progressBar } from '../src/persona/bond.js';
import { activityFor, dailyMood, specialDay } from '../src/persona/mood.js';
import { dayKey, zonedWallTimeToUtc } from '../src/util/time.js';

function collect(events: StreamEvent[]) {
  let content = '';
  let reasoning = '';
  for (const e of events) {
    if (e.type === 'content') content += e.text;
    else if (e.type === 'reasoning') reasoning += e.text;
    else if (e.type === 'reclassify') {
      reasoning += content;
      content = '';
    }
  }
  return { content, reasoning };
}

describe('ThinkSplitter', () => {
  it('splits <think> blocks across chunk boundaries', () => {
    const s = new ThinkSplitter(true);
    const ev = [...s.push('<thi'), ...s.push('nk>plan it'), ...s.push(' out</th'), ...s.push('ink>Answer!'), ...s.flush()];
    expect(collect(ev)).toEqual({ content: 'Answer!', reasoning: 'plan it out' });
  });
  it('reclassifies content before a stray </think>', () => {
    const s = new ThinkSplitter(true);
    const ev = [...s.push('reasoning text'), ...s.push('</think>final'), ...s.flush()];
    expect(collect(ev)).toEqual({ content: 'final', reasoning: 'reasoning text' });
  });
  it('passes plain content straight through when thinking is off', () => {
    const s = new ThinkSplitter(false);
    expect(collect([...s.push('hello '), ...s.push('world'), ...s.flush()])).toEqual({ content: 'hello world', reasoning: '' });
  });
});

describe('parseCompletion / JSON helpers', () => {
  it('parses reasoning_content, tool calls and think tags', () => {
    const c = parseCompletion(
      { choices: [{ message: { content: '<think>hmm</think>Hi', tool_calls: [{ id: 't1', function: { name: 'roll_dice', arguments: { emoji: '🎲' } } }] }, finish_reason: 'tool_calls' }] },
      true,
    );
    expect(c.content).toBe('Hi');
    expect(c.reasoning).toBe('hmm');
    expect(c.toolCalls[0]?.function.name).toBe('roll_dice');
    expect(JSON.parse(c.toolCalls[0]!.function.arguments)).toEqual({ emoji: '🎲' });
  });
  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson<string[]>('Sure!\n```json\n["a","b"]\n```')).toEqual(['a', 'b']);
    expect(extractJson<{ x: number }>('result: {"x": 3} ok')).toEqual({ x: 3 });
    expect(extractJson('nothing here')).toBeNull();
  });
  it('recovers tool calls leaked into content', () => {
    const r = extractLeakedToolCalls('Okay! <tool_call>{"name": "remember_fact", "arguments": {"fact": "Likes cats"}}</tool_call>');
    expect(r.text).toBe('Okay!');
    expect(r.calls[0]?.function.name).toBe('remember_fact');
  });
});

describe('readSse', () => {
  it('parses CRLF, comments and multi-line data', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(': keep-alive\r\ndata: {"a":1}\r\n\r\ndata: line1\n'));
        c.enqueue(enc.encode('data: line2\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of readSse(body)) out.push(d);
    expect(out).toEqual(['{"a":1}', 'line1\nline2', '[DONE]']);
  });
});

describe('RateLimiter / WindowCounter', () => {
  it('grants up to rpm immediately and serves high priority first', async () => {
    let t = 0;
    const lim = new RateLimiter(2, 1000, () => t);
    await lim.acquire('low');
    await lim.acquire('low');
    const order: string[] = [];
    const a = lim.acquire('low').then(() => order.push('low'));
    const b = lim.acquire('high').then(() => order.push('high'));
    t = 1100;
    lim.setRpm(2); // re-pump with the advanced clock
    await Promise.all([a, b]);
    expect(order).toEqual(['high', 'low']);
  });
  it('counts hits per key in a sliding window', () => {
    let t = 0;
    const w = new WindowCounter(2, 1000, () => t);
    expect(w.hit('u')).toBe(true);
    expect(w.hit('u')).toBe(true);
    expect(w.hit('u')).toBe(false);
    t = 1500;
    expect(w.hit('u')).toBe(true);
  });
});

describe('ConvQueue', () => {
  it('runs one turn per conversation and merges queued items', async () => {
    const batches: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new ConvQueue<string>(
      async (_c, batch) => {
        batches.push(batch);
        if (batches.length === 1) await gate;
      },
      () => true,
    );
    q.push('c1', 'first');
    q.push('c1', 'second');
    q.push('c1', 'third');
    await new Promise((r) => setTimeout(r, 10));
    release();
    await q.idle();
    expect(batches).toEqual([['first'], ['second', 'third']]);
  });
});

describe('time', () => {
  it('converts local wall time in a timezone to UTC', () => {
    expect(zonedWallTimeToUtc('2026-09-26T09:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-09-26T03:30:00.000Z');
    expect(zonedWallTimeToUtc('2026-01-15T12:00', 'Europe/Moscow')?.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(zonedWallTimeToUtc('nonsense', 'UTC')).toBeNull();
  });
  it('computes day keys per zone', () => {
    const d = new Date('2026-09-25T22:30:00Z');
    expect(dayKey(d, 'UTC')).toBe('2026-09-25');
    expect(dayKey(d, 'Asia/Kolkata')).toBe('2026-09-26');
  });
});

describe('tools', () => {
  const cfg = { ...loadConfig(), maxMemories: 5 };
  function env(store: Store, over: Partial<ToolEnv> = {}): ToolEnv {
    return { kind: 'private', userId: 7, chatId: 7, timezone: null, now: new Date('2026-09-25T10:00:00Z'), store, cfg, canDraw: true, deferred: [], ...over };
  }
  const call = (name: string, args: unknown) => ({ id: 'c', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

  it('exposes context-appropriate tools', () => {
    expect(toolDefs('guest', false).map((t) => t.function.name)).toEqual(['remember_fact', 'forget_fact', 'set_timezone']);
    expect(toolDefs('private', true).map((t) => t.function.name)).toContain('generate_image');
  });

  it('remembers, dedupes and forgets facts', () => {
    const store = new Store(':memory:');
    store.upsertUser({ id: 7, first_name: 'A' });
    expect(runTool(call('remember_fact', { fact: 'Has a dog named Bruno' }), env(store)).result.saved).toBe(true);
    expect(runTool(call('remember_fact', { fact: 'has a dog named bruno' }), env(store)).result.saved).toBe(false);
    expect(runTool(call('forget_fact', { query: 'bruno' }), env(store)).result.deleted).toBe(1);
  });

  it('sets reminders relative and absolute, and asks for a timezone when unknown', () => {
    const store = new Store(':memory:');
    store.upsertUser({ id: 7, first_name: 'A' });
    const rel = runTool(call('set_reminder', { text: 'drink water', in_minutes: 30 }), env(store));
    expect(rel.result.ok).toBe(true);
    expect(rel.note).toMatch(/tg:\/\/time\?unix=\d+&format=wDT/);
    const abs = runTool(call('set_reminder', { text: 'call mom', at_local_time: '2026-09-26T09:00' }), env(store));
    expect(abs.result.ok).toBe(false);
    expect(String(abs.result.error)).toMatch(/timezone/);
    const withTz = runTool(call('set_reminder', { text: 'call mom', at_local_time: '2026-09-26T09:00' }), env(store, { timezone: 'Asia/Kolkata' }));
    expect(withTz.result.due_utc).toBe('2026-09-26T03:30:00.000Z');
    expect(store.pendingReminders(7)).toHaveLength(2);
  });

  it('validates quizzes and defers dice/images', () => {
    const store = new Store(':memory:');
    const e = env(store);
    expect(runTool(call('create_quiz', { question: 'Q?', options: ['a'], correct_option_ids: [0] }), e).result.ok).toBe(false);
    expect(runTool(call('create_quiz', { question: 'Capital of Russia?', options: ['Moscow', 'Kazan'], correct_option_ids: [0] }), e).result.ok).toBe(true);
    runTool(call('roll_dice', { emoji: '🎯' }), e);
    runTool(call('generate_image', { prompt: 'a cat in a scarf' }), e);
    expect(e.deferred.map((d) => d.type)).toEqual(['quiz', 'dice', 'image']);
  });

  it('rejects invalid timezones', () => {
    const store = new Store(':memory:');
    store.upsertUser({ id: 7, first_name: 'A' });
    expect(runTool(call('set_timezone', { timezone: 'Mars/Olympus' }), env(store)).result.ok).toBe(false);
    expect(runTool(call('set_timezone', { timezone: 'Asia/Kolkata' }), env(store)).result.ok).toBe(true);
    expect(store.getUser(7)?.timezone).toBe('Asia/Kolkata');
  });
});

describe('audio', () => {
  it('parses WAV and encodes MP3 frames', () => {
    const sr = 22050;
    const pcm = new Int16Array(sr);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 10000);
    const wav = makeWav(pcm, sr);
    const parsed = parseWav(wav, 44100);
    expect(parsed.sampleRate).toBe(sr);
    expect(parsed.samples.length).toBe(sr);
    const mp3 = pcmToMp3(parsed);
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1] as number) & 0xe0).toBe(0xe0);
  });
  it('treats headerless audio as raw PCM', () => {
    expect(parseWav(Buffer.alloc(200), 16000).samples.length).toBe(100);
  });
  it('prepares speech text without markdown, code or spoiler translations', () => {
    const t = prepareSpeech('**Hi!** Не то чтобы… ||(It\'s not like…)||\n```js\nx\n```\nSee https://x.test ✨');
    expect(t).not.toContain('**');
    expect(t).not.toContain('It\'s not like');
    expect(t).toContain('(code)');
    expect(t).toContain('the link');
  });
  it('blocks unsafe image prompts', () => {
    expect(imagePromptProblem('a nude person')).toBe('nsfw');
    expect(imagePromptProblem('a cat wearing a winter scarf')).toBeNull();
  });
});

describe('persona', () => {
  it('builds a prompt with persona, live context, memories and tools', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-01-07T09:00:00Z'),
      kind: 'private',
      userName: 'Rahul',
      bond: 40,
      streak: 3,
      daysTalked: 10,
      timezone: 'Asia/Kolkata',
      memories: ['Has a dog named Bruno'],
      tools: true,
      canDraw: true,
      canVoice: true,
    });
    expect(prompt).toContain('You are **Alya**');
    expect(prompt).toContain('Saint Petersburg');
    expect(prompt).toContain('Good friend');
    expect(prompt).toContain('Has a dog named Bruno');
    expect(prompt).toContain('BIRTHDAY');
    expect(prompt).toContain('set_reminder');
    expect(prompt).toContain('||spoiler||');
    expect(prompt).toMatch(/AI companion/);
  });
  it('group prompts explain the group and skip private bond details', () => {
    const prompt = buildSystemPrompt({ now: new Date(), kind: 'group', groupTitle: 'Devs', userName: 'A', bond: 0, streak: 0, daysTalked: 0, memories: [], tools: false, canDraw: false, canVoice: false });
    expect(prompt).toContain('group chat "Devs"');
    expect(prompt).not.toContain('Your bond:');
    expect(prompt).not.toContain('## Tools');
  });
  it('mood is stable within a day and time-of-day aware', () => {
    const a = dailyMood(new Date('2026-09-25T08:00:00Z'));
    const b = dailyMood(new Date('2026-09-25T18:00:00Z'));
    expect(a.key).toBe(b.key);
    expect(activityFor(new Date('2026-09-25T23:30:00Z'))).toMatch(/middle of the night/); // 02:30 in Moscow
    expect(specialDay(new Date('2026-01-07T12:00:00Z'))).toMatch(/BIRTHDAY/);
  });
  it('bond levels and progress bars', () => {
    expect(bondLevel(0).label).toBe('New acquaintance');
    expect(bondLevel(90).label).toBe('Best friend');
    expect(progressBar(50)).toBe('▰▰▰▰▰▱▱▱▱▱');
  });
});

describe('policy', () => {
  it('routes reasoning by complexity and settings', () => {
    expect(chooseThinking('hi alya!', 'auto', false).thinking).toBe(false);
    expect(chooseThinking('Solve 12*34 step by step', 'auto', false).thinking).toBe('low');
    expect(chooseThinking('hi', 'fast', true).thinking).toBe(true);
    expect(chooseThinking('hi', 'deep', false).thinking).toBe(true);
  });
  it('picks reactions and effects', () => {
    expect(pickReaction('thank you so much!', () => 0)).toBe('🤗');
    expect(pickReaction('thank you so much!', () => 0.99)).toBeNull();
    expect(pickReaction('what is a monad', () => 0)).toBeNull();
    expect(chooseEffect('I passed my exam!', 10, false)).toBe(EFFECTS.party);
    expect(chooseEffect('hi', 10, true)).toBe(EFFECTS.fire);
    expect(chooseEffect('I love you', 10, false)).toBeUndefined();
    expect(chooseEffect('I love you', 70, false)).toBe(EFFECTS.heart);
  });
  it('action keyboard fits callback_data limits', () => {
    const kb = actionKeyboard('abcdefgh', { voice: true, deep: true });
    for (const b of kb.inline_keyboard.flat()) expect(Buffer.byteLength((b as { callback_data: string }).callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('Store', () => {
  it('tracks streaks, bond and milestones', () => {
    const s = new Store(':memory:');
    s.upsertUser({ id: 1, first_name: 'A' });
    expect(s.touchActivity(1, '2026-09-01', '2026-08-31')).toMatchObject({ streak: 1, newDay: true });
    expect(s.touchActivity(1, '2026-09-01', '2026-08-31')).toMatchObject({ streak: 1, newDay: false });
    s.touchActivity(1, '2026-09-02', '2026-09-01');
    const r = s.touchActivity(1, '2026-09-03', '2026-09-02');
    expect(r).toMatchObject({ streak: 3, milestone: true });
    expect(s.getUser(1)?.bond).toBeGreaterThan(0);
    s.touchActivity(1, '2026-09-10', '2026-09-09');
    expect(s.getUser(1)?.streak).toBe(1);
    expect(s.getUser(1)?.best_streak).toBe(3);
  });
  it('caps memories and prunes history per conversation', () => {
    const s = new Store(':memory:');
    for (let i = 0; i < 8; i++) s.addMemory(1, `Fact number ${i} about something unique ${i * 7}`, 'test', 5);
    expect(s.listMemories(1)).toHaveLength(5);
    for (let i = 0; i < 30; i++) s.addMessage({ conv: '1:0', role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    expect(s.recentMessages('1:0', 4).map((m) => m.content)).toEqual(['m26', 'm27', 'm28', 'm29']);
    s.pruneOldMessages(10);
    expect(s.countMessages('1:0')).toBe(10);
  });
  it('stores settings and deletes all user data', () => {
    const s = new Store(':memory:');
    s.upsertUser({ id: 5, first_name: 'B' });
    expect(s.updateUserSettings(5, { voice: 'always' }).voice).toBe('always');
    s.addMemory(5, 'Likes tea', 't', 10);
    s.addReminder({ userId: 5, chatId: 5, text: 'x', dueAt: Date.now() + 1000 });
    s.deleteUserData(5);
    expect(s.getUser(5)).toBeUndefined();
    expect(s.listMemories(5)).toHaveLength(0);
  });
});
