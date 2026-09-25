/** More end-to-end features: topics, stop buttons, fallbacks, memory, degraded media. */
import { afterEach, describe, expect, it } from 'vitest';
import { maybeMaintainMemory } from '../src/chat/memory.js';
import { groupText, harness, privateText, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('private-chat topics (Bot API 9.3/9.4)', () => {
  it('/new creates a topic, and the first exchange there gets an AI title', async () => {
    h = await harness({}, { has_topics_enabled: true } as never);
    await h.send(privateText('/new'));
    await h.settle();
    const created = h.tg.callsOf('createForumTopic')[0]!;
    expect(created.payload.chat_id).toBe(42);
    const greet = h.tg.callsOf('sendMessage')[0]!;
    expect(greet.payload.message_thread_id).toBe(77);

    h.nv.chatHandler = (b) => {
      const sys = (b.messages as Array<{ content: string }>)[0]!.content;
      if (sys.includes('Write a short, cute title')) return { chunks: [{ content: '🍜 Ramen Adventures' }] };
      return { chunks: [{ content: 'Ramen is life! 🍜' }] };
    };
    await h.send(privateText('what is the best ramen?', { extra: { message_thread_id: 77, is_topic_message: true } }));
    await h.settle();
    await h.tg.waitFor((calls) => calls.some((c) => c.method === 'editForumTopic'));
    const draft = h.tg.callsOf('sendRichMessageDraft')[0]!;
    expect(draft.payload.message_thread_id).toBe(77);
    const final = h.tg.callsOf('sendRichMessage').at(-1)!;
    expect(final.payload.message_thread_id).toBe(77);
    const edit = h.tg.callsOf('editForumTopic')[0]!;
    expect(edit.payload.message_thread_id).toBe(77);
    expect(edit.payload.name).toBe('🍜 Ramen Adventures');
    expect(h.app.store.getTopic(42, 77)?.titled).toBe(1);
    expect(h.app.store.recentMessages('42:77', 5)).toHaveLength(2);
  });
});

describe('group stop button', () => {
  it('only the asker can stop; stopping keeps the partial answer', async () => {
    h = await harness();
    h.nv.chatHandler = () => ({ chunks: Array.from({ length: 50 }, (_, i) => ({ content: `part${i} ` })), delayMs: 50 });
    await h.send(groupText('@alya_test_bot write a long poem', { messageId: 900 }));
    await h.tg.waitFor((calls) => calls.some((c) => c.method === 'sendRichMessage'));
    const kb = h.tg.callsOf('sendRichMessage')[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const data = kb.inline_keyboard[0]![0]!.callback_data;
    const cb = (userId: number, id: string) => ({
      callback_query: { id, from: { id: userId, is_bot: false, first_name: 'X' }, chat_instance: 'c', data, message: { message_id: 100, date: 0, chat: { id: -100123, type: 'supergroup', title: 'Test Group' } } },
    });
    await h.send(cb(55, 'other') as never);
    const denied = h.tg.callsOf('answerCallbackQuery').at(-1)!;
    expect(String(denied.payload.text)).toMatch(/Only the person who asked/);
    await new Promise((r) => setTimeout(r, 300));
    await h.send(cb(42, 'owner') as never);
    await h.settle();
    const last = h.tg.callsOf('editMessageText').at(-1)!;
    const md = (last.payload.rich_message as { markdown: string }).markdown;
    expect(md).toContain('part0');
    expect(md).not.toContain('part49');
    expect(md).toMatch(/⏹/);
  });
});

describe('fallbacks', () => {
  it('drops a rejected message effect, blacklists it, and still delivers', async () => {
    h = await harness();
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Поздравляю! 🎉' }] });
    h.tg.on('sendRichMessage', (p) => (p.message_effect_id ? { error_code: 400, description: 'Bad Request: EFFECT_ID_INVALID' } : undefined));
    await h.send(privateText('I passed my exam!'));
    await h.settle();
    const sends = h.tg.callsOf('sendRichMessage');
    expect(sends[0]!.payload.message_effect_id).toBe('5046509860389126442');
    expect(sends[1]!.payload.message_effect_id).toBeUndefined();
    expect((sends[1]!.payload.rich_message as { markdown: string }).markdown).toContain('Поздравляю');
    // blacklisted: the next celebration does not try the effect again
    await h.send(privateText('I passed another exam!'));
    await h.settle();
    const more = h.tg.callsOf('sendRichMessage').slice(2);
    expect(more.every((c) => c.payload.message_effect_id === undefined)).toBe(true);
  });

  it('remembers when the Bot API server has no rich methods and uses classic drafts + HTML', async () => {
    h = await harness();
    h.tg.on('sendRichMessageDraft', () => ({ error_code: 404, description: 'Not Found: method not found' }));
    h.tg.on('sendRichMessage', () => ({ error_code: 404, description: 'Not Found: method not found' }));
    h.nv.chatHandler = () => ({ chunks: [{ content: '**Hello** there' }], delayMs: 50 });
    await h.send(privateText('hi'));
    await h.settle();
    expect(h.tg.callsOf('sendMessageDraft').length).toBeGreaterThan(0);
    const html = h.tg.callsOf('sendMessage').find((c) => c.payload.parse_mode === 'HTML')!;
    expect(String(html.payload.text)).toContain('<b>Hello</b>');
    expect(h.app.renderer.richUnsupported).toBe(true);
    const richCallsBefore = h.tg.callsOf('sendRichMessage').length;
    await h.send(privateText('again'));
    await h.settle();
    expect(h.tg.callsOf('sendRichMessage').length).toBe(richCallsBefore);
  });

  it('still answers when a media file cannot be downloaded', async () => {
    h = await harness();
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Hmm, I couldn\'t open that photo 🙈' }] });
    await h.send(privateText('', { extra: { text: undefined, caption: 'what is this?', photo: [{ file_id: 'missing', file_unique_id: 'm', width: 10, height: 10, file_size: 100 }] } }));
    await h.settle();
    const last = (h.nv.chatRequests().at(-1)!.messages as Array<{ content: string }>).at(-1)!.content;
    expect(last).toContain("couldn't open it");
    expect(last).toContain('what is this?');
    expect(h.tg.callsOf('sendRichMessage')).toHaveLength(1);
  });
});

describe('background memory', () => {
  it('extracts long-term facts with the light model every few messages', async () => {
    h = await harness();
    h.app.store.upsertUser({ id: 42, first_name: 'Rahul' });
    for (let i = 0; i < 8; i++) h.app.store.addMessage({ conv: '42:0', role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'I live in Pune and I study medicine' : `msg ${i}`, name: 'Rahul', userId: 42 });
    h.nv.chatHandler = () => ({ chunks: [{ content: '["They live in Pune", "They study medicine"]' }] });
    await maybeMaintainMemory(h.app, '42:0', 42, 'private');
    expect(h.app.store.listMemories(42).map((m) => m.fact)).toEqual(['They live in Pune', 'They study medicine']);
    const req = h.nv.chatRequests()[0]!;
    expect(req.model).toBe(h.cfg.lightModel);
    // nothing new since → no second extraction request
    await maybeMaintainMemory(h.app, '42:0', 42, 'private');
    expect(h.nv.chatRequests()).toHaveLength(1);
  });
});

describe('guardrails', () => {
  it('flood control warns once and drops excess messages', async () => {
    h = await harness({ userMsgsPerMin: 2 });
    h.nv.chatHandler = () => ({ chunks: [{ content: 'ok' }] });
    for (let i = 0; i < 5; i++) await h.send(privateText(`spam ${i}`));
    await h.settle();
    const warnings = h.tg.callsOf('sendMessage').filter((c) => String(c.payload.text).includes('slow down'));
    expect(warnings).toHaveLength(1);
    expect(h.nv.chatRequests().length).toBeLessThanOrEqual(2);
  });

  it('banned users are ignored, admins can ban via command', async () => {
    h = await harness();
    await h.send(privateText('/ban 42', { userId: 1, firstName: 'Owner' }));
    await h.settle();
    expect(h.app.store.getUser(42)?.banned).toBe(1);
    h.tg.reset();
    await h.send(privateText('hello?'));
    await h.settle();
    expect(h.tg.calls).toHaveLength(0);
    expect(h.nv.chatRequests()).toHaveLength(0);
  });
});

describe('privacy', () => {
  it('never puts private memories into group, guest or inline prompts', async () => {
    h = await harness();
    h.app.store.upsertUser({ id: 42, first_name: 'Rahul' });
    h.app.store.addMemory(42, 'Secretly afraid of pigeons', 'test', 50);
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Hi!' }] });
    await h.send(groupText('@alya_test_bot hi'));
    await h.settle();
    await h.send(privateText('hi'));
    await h.settle();
    const [groupReq, privateReq] = h.nv.chatRequests();
    const sys = (r: Record<string, unknown>) => (r.messages as Array<{ content: string }>)[0]!.content;
    expect(sys(groupReq!)).not.toContain('pigeons');
    expect(sys(privateReq!)).toContain('pigeons');
  });
});

describe('"Let\'s talk" opener', () => {
  it('Alya greets first and still remembers her greeting on the next turn', async () => {
    h = await harness();
    h.nv.chatHandler = (_b, i) => ({ chunks: [{ content: i === 0 ? 'Привет! What should I call you?' : 'Nice to meet you, Rahul!' }] });
    await h.send({
      callback_query: { id: 't', from: { id: 42, is_bot: false, first_name: 'Rahul' }, chat_instance: 'c', data: 'talk', message: { message_id: 3, date: 0, chat: { id: 42, type: 'private', first_name: 'Rahul' } } },
    } as never);
    await h.settle();
    await h.send(privateText('call me Rahul'));
    await h.settle();
    const msgs = h.nv.chatRequests()[1]!.messages as Array<{ role: string; content: string }>;
    expect(msgs.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content).toContain('What should I call you?');
  });
});
