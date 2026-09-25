import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store.js';
import { resolveReplyLanguage } from '../src/persona/language.js';
import { harness, privateText, groupText, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

function latestPrompt(): string {
  return (h!.nv.chatRequests().at(-1)!.messages as Array<{ content: string }>)[0]!.content;
}

function expectLanguage(language: 'Hinglish' | 'English'): void {
  expect(latestPrompt()).toContain(`Current reply language: ${language}.`);
}

describe('reply language detection', () => {
  it.each(['hi', 'ok', 'thank you', '👍', '42', 'Rahul', '', 'https://example.com/how-are-you', '`what is this`', '```js\nconst name = "what is this";\n```', '> how are you'])('keeps the current choice for ambiguous/data-only input: %s', (text) => {
    expect(resolveReplyLanguage(text)).toBe('hinglish');
    expect(resolveReplyLanguage(text, 'english')).toBe('english');
  });

  it.each(['How are you?', 'Can you help me with this code?', 'I am fine', 'Explain the main idea', 'capital of Japan?', 'Help please'])('switches to English: %s', (text) => {
    expect(resolveReplyLanguage(text)).toBe('english');
  });

  it.each(['kaise ho?', 'aaj kya plan hai', 'mujhe code explain karo', 'I am fine yaar', 'yeh function kya karta hai?', 'तुम कैसे हो?'])('switches back to Hinglish: %s', (text) => {
    expect(resolveReplyLanguage(text, 'english')).toBe('hinglish');
  });

  it.each([
    ['English mein bolo', 'english'], ['please reply in English', 'english'],
    ['English only', 'english'], ['Can you speak in Hinglish?', 'hinglish'],
    ['Please use Hindi', 'hinglish'], ['reply in Hinglish from now on', 'hinglish'],
  ] as const)('honors a direct request: %s', (text, expected) => {
    expect(resolveReplyLanguage(text, expected === 'english' ? 'hinglish' : 'english')).toBe(expected);
  });
});

describe('per-user language persistence', () => {
  it('defaults old settings to Hinglish and persists changes across database reopen/profile refresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alya-language-'));
    const path = join(dir, 'test.sqlite');
    let store = new Store(path);
    try {
      store.upsertUser({ id: 42, language_code: 'en' });
      store.db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify({ voice: 'off', nickname: 'R' }), 42);
      expect(store.getUser(42)?.settings.replyLanguage).toBe('hinglish');
      store.updateUserSettings(42, { replyLanguage: 'english' });
      store.close();
      store = new Store(path);
      store.upsertUser({ id: 42, language_code: 'hi' });
      expect(store.getUser(42)?.settings).toMatchObject({ replyLanguage: 'english', voice: 'off', nickname: 'R' });
      expect(store.upsertUser({ id: 43 })[0].settings.replyLanguage).toBe('hinglish');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts in Hinglish, switches immediately, and follows the person across chats without affecting others', async () => {
    h = await harness();
    await h.send(privateText('hi')); // Telegram UI is English, but not a language preference.
    await h.settle();
    expectLanguage('Hinglish');
    await h.send(privateText('Can you help me with my homework?'));
    await h.settle();
    expectLanguage('English');
    expect(h.app.store.getUser(42)?.settings.replyLanguage).toBe('english');
    await h.send(groupText('@alya_test_bot ok'));
    await h.settle();
    expectLanguage('English');
    await h.send(groupText('@alya_test_bot hi', { userId: 43 }));
    await h.settle();
    expectLanguage('Hinglish');
    await h.send(groupText('@alya_test_bot haan ab samjhao', { userId: 42 }));
    await h.settle();
    expectLanguage('Hinglish');
    expect(h.app.store.getUser(42)?.settings.replyLanguage).toBe('hinglish');
  });

  it('ignores quoted replies and uncaptioned media but uses the actual caption', async () => {
    h = await harness();
    await h.send(privateText('👍', { extra: {
      reply_to_message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, from: { id: 43, first_name: 'Other' }, text: 'How are you today?' },
    } }));
    await h.settle();
    expectLanguage('Hinglish');
    const photo = { text: undefined, photo: [{ file_id: 'missing', file_unique_id: 'm', width: 10, height: 10, file_size: 100 }] };
    await h.send(privateText('', { extra: photo }));
    await h.settle();
    expectLanguage('Hinglish'); // Even the English media-failure wrapper must not change it.
    await h.send(privateText('', { extra: { ...photo, caption: 'What is this?' } }));
    await h.settle();
    expectLanguage('English');
  });

  it('uses voice transcripts, not the English media wrapper, to update the preference', async () => {
    h = await harness();
    h.tg.files.set('files/voice-language', Buffer.from('OggS-fake-opus'));
    const voice = { text: undefined, voice: { file_id: 'voice-language', file_unique_id: 'v', duration: 3, mime_type: 'audio/ogg' } };
    h.nv.transcript = 'How are you doing today?';
    await h.send(privateText('', { extra: voice }));
    await h.settle();
    expectLanguage('English');
    h.nv.transcript = 'aaj kya kar rahi ho';
    await h.send(privateText('', { extra: voice }));
    await h.settle();
    expectLanguage('Hinglish');
    expect(h.app.store.getUser(42)?.settings.replyLanguage).toBe('hinglish');
  });

  it('shares the user preference with inline and guest turns without sharing private context', async () => {
    h = await harness();
    await h.send({ chosen_inline_result: {
      result_id: 'ask:test', from: { id: 42, is_bot: false, first_name: 'Rahul' },
      query: 'Can you explain gravity?', inline_message_id: 'inl-language',
    } } as never);
    await h.settle();
    expectLanguage('English');
    expect(h.app.store.getUser(42)?.settings.replyLanguage).toBe('english');
    h.app.store.addMemory(42, 'Private secret', 'test', 50);
    await h.send({ guest_message: {
      message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: -555, type: 'supergroup', title: 'Other' },
      from: { id: 42, is_bot: false, first_name: 'Rahul' }, text: '@alya_test_bot ok',
      guest_query_id: 'guest-language', guest_bot_caller_user: { id: 42, is_bot: false, first_name: 'Rahul' },
    } } as never);
    await h.settle();
    expectLanguage('English');
    expect(latestPrompt()).not.toContain('Private secret');
  });

  it('does not treat a synthetic conversation opener as English speech', async () => {
    h = await harness();
    await h.send({ callback_query: {
      id: 'talk', from: { id: 42, is_bot: false, first_name: 'Rahul' }, chat_instance: 'c', data: 'talk',
      message: { message_id: 3, date: 0, chat: { id: 42, type: 'private', first_name: 'Rahul' } },
    } } as never);
    await h.settle();
    expectLanguage('Hinglish');
  });
});
