/**
 * End-to-end: real grammY bot + mock Telegram Bot API + mock NVIDIA.
 * Each test asserts the exact API behaviour for one Bot API feature.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverDueReminders } from '../src/scheduler.js';
import { groupText, harness, privateText, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const finalRich = () => h.tg.callsOf('sendRichMessage').map((c) => (c.payload.rich_message as { markdown?: string; blocks?: unknown[] }) ?? {});

describe('private chat streaming (Bot API 10.1/10.3 drafts)', () => {
  it('streams drafts with can_stop and finalizes with sendRichMessage + action buttons', async () => {
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Привет! ' }, { content: 'I am **Alya**.' }, { content: '\n\n| a | b |\n|---|---|\n| 1 | 2 |' }], delayMs: 120 });
    await h.send(privateText('hi there'));
    await h.settle();

    const drafts = h.tg.callsOf('sendRichMessageDraft');
    expect(drafts.length).toBeGreaterThan(0);
    const ids = new Set(drafts.map((d) => d.payload.draft_id));
    expect(ids.size).toBe(1); // same draft id → animated updates
    expect(drafts[0]!.payload.can_stop).toBe(true);
    expect(drafts[0]!.payload.keep_on_stop).toBe(true);
    expect(String((drafts[0]!.payload.rich_message as { markdown: string }).markdown)).toContain('<tg-thinking>');

    const finals = h.tg.callsOf('sendRichMessage');
    expect(finals).toHaveLength(1);
    const md = (finals[0]!.payload.rich_message as { markdown: string }).markdown;
    expect(md).toContain('I am **Alya**.');
    expect(md).toContain('| a | b |');
    expect(md).not.toContain('tg-thinking');
    const kb = finals[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(kb.inline_keyboard[0]!.map((b) => b.callback_data.split(':')[0])).toEqual(['rg', 'tts', 'deep']);

    // the model got Alya's persona and the user's message
    const req = h.nv.chatRequests()[0]!;
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('You are **Alya**');
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'hi there' });
    expect(req.stream).toBe(true);
    expect((req.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false);

    // history persisted for the next turn
    expect(h.app.store.recentMessages('42:0', 10).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('shows reasoning in a thinking block for complex questions, never in the final message', async () => {
    h.nv.chatHandler = () => ({ chunks: [{ reasoning: 'Let me compute 12*34 carefully. ' }, { reasoning: '12*34 = 408.' }, { content: 'It is **408** ✨' }], delayMs: 300 });
    await h.send(privateText('Solve 12*34 step by step'));
    await h.settle();
    const req = h.nv.chatRequests()[0]!;
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: true, low_effort: true });
    const draftTexts = h.tg.callsOf('sendRichMessageDraft').map((d) => (d.payload.rich_message as { markdown: string }).markdown);
    expect(draftTexts.some((t) => t.includes('<tg-thinking>') && t.includes('408'))).toBe(true);
    const md = finalRich()[0]!.markdown!;
    expect(md).toContain('It is **408**');
    expect(md).not.toContain('tg-thinking');
  });

  it('stops on stopped_message_generation (draft_id as a string) and keeps the partial answer', async () => {
    h.nv.chatHandler = () => ({ chunks: Array.from({ length: 40 }, (_, i) => ({ content: `word${i} ` })), delayMs: 60 });
    await h.send(privateText('tell me a long story'));
    await h.tg.waitFor((calls) => calls.some((c) => c.method === 'sendRichMessageDraft' && String((c.payload.rich_message as { markdown: string }).markdown).includes('word3')));
    const draft = h.tg.callsOf('sendRichMessageDraft')[0]!;
    await h.send({ stopped_message_generation: { chat: { id: 42, type: 'private', first_name: 'Rahul' }, draft_id: String(draft.payload.draft_id) } } as never);
    await h.settle();
    const md = finalRich()[0]!.markdown!;
    expect(md).toContain('word0');
    expect(md).not.toContain('word39');
    expect(md).toMatch(/⏹/);
  });

  it('falls back to classic HTML when Telegram rejects the rich message', async () => {
    h.nv.chatHandler = () => ({ chunks: [{ content: '# Title\n\n**bold** text' }] });
    h.tg.failOnce('sendRichMessage', { error_code: 400, description: 'Bad Request: can\'t parse rich message' });
    await h.send(privateText('hello'));
    await h.settle();
    const classic = h.tg.callsOf('sendMessage').find((c) => c.payload.parse_mode === 'HTML');
    expect(classic).toBeDefined();
    expect(String(classic!.payload.text)).toContain('<b>Title</b>');
    expect(String(classic!.payload.text)).toContain('<b>bold</b>');
    expect(classic!.payload.reply_markup).toBeDefined();
  });

  it('batches messages sent while Alya is still typing into one turn', async () => {
    h.nv.chatHandler = (_b, i) => ({ chunks: [{ content: `reply ${i}` }], delayMs: i === 0 ? 400 : 0 });
    await h.send(privateText('first', { messageId: 1 }));
    await new Promise((r) => setTimeout(r, 60));
    await h.send(privateText('second', { messageId: 2 }));
    await h.send(privateText('third', { messageId: 3 }));
    await h.settle();
    const reqs = h.nv.chatRequests();
    expect(reqs).toHaveLength(2);
    const last = reqs[1]!.messages as Array<{ role: string; content: string }>;
    expect(last[last.length - 1]!.content).toBe('second\nthird');
  });

  it('executes tools: remembers facts and sets a reminder with a localized time note', async () => {
    h.nv.chatHandler = () => ({
      chunks: [
        { content: 'Okay, I\'ll remember that and remind you! ' },
        {
          tool_calls: [
            { index: 0, id: 'a', type: 'function', function: { name: 'remember_fact', arguments: '{"fact": "Has a dog named Bruno"}' } },
            { index: 1, id: 'b', type: 'function', function: { name: 'set_reminder', arguments: '{"text": "walk Bruno", "in_minutes": 45}' } },
          ],
        },
      ],
      finish: 'tool_calls',
    });
    await h.send(privateText('my dog is Bruno, remind me in 45 minutes to walk him'));
    await h.settle();
    expect(h.app.store.listMemories(42).map((m) => m.fact)).toEqual(['Has a dog named Bruno']);
    const rem = h.app.store.pendingReminders(42);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.text).toBe('walk Bruno');
    const md = finalRich()[0]!.markdown!;
    expect(md).toMatch(/Reminder set/);
    expect(md).toMatch(/tg:\/\/time\?unix=\d+&format=wDT/);
    expect(h.nv.chatRequests()[0]!.tools).toBeDefined();
  });

  it('runs a follow-up round when the model only calls tools, then sends deferred dice', async () => {
    h.nv.chatHandler = (_b, i) =>
      i === 0
        ? { chunks: [{ tool_calls: [{ index: 0, id: 'd', type: 'function', function: { name: 'roll_dice', arguments: '{"emoji":"🎲"}' } }] }], finish: 'tool_calls' }
        : { chunks: [{ content: 'Rolling for you! 🎲' }] };
    await h.send(privateText('roll a dice'));
    await h.settle();
    const reqs = h.nv.chatRequests();
    expect(reqs).toHaveLength(2);
    const second = reqs[1]!.messages as Array<{ role: string }>;
    expect(second.map((m) => m.role).slice(-2)).toEqual(['assistant', 'tool']);
    expect(finalRich()[0]!.markdown).toContain('Rolling for you!');
    const dice = h.tg.callsOf('sendDice');
    expect(dice).toHaveLength(1);
    expect(dice[0]!.payload.emoji).toBe('🎲');
    expect(h.tg.methods().indexOf('sendDice')).toBeGreaterThan(h.tg.methods().indexOf('sendRichMessage'));
  });

  it('disables tools and retries when the API rejects tool definitions', async () => {
    h.nv.chatHandler = (b) => (b.tools ? { error: { status: 400, body: { error: { message: 'tools are not supported for this model' } } } } : { chunks: [{ content: 'Fine without tools' }] });
    await h.send(privateText('hello'));
    await h.settle();
    expect(finalRich()[0]!.markdown).toContain('Fine without tools');
    expect(h.app.flags.toolsBroken).toBe(true);
  });

  it('tells the user in character when NVIDIA is rate limited', async () => {
    h.nv.chatHandler = () => ({ error: { status: 429, body: { detail: 'Too Many Requests' }, retryAfter: 0.01 } });
    await h.send(privateText('hello'));
    await h.settle();
    const fail = h.tg.callsOf('sendMessage').at(-1);
    expect(String(fail?.payload.text)).toMatch(/too many people|spinning/i);
  }, 30_000);
});

describe('media senses', () => {
  it('hears a voice message (ASR over NVCF HTTP), shows the transcript and answers with voice in auto mode', async () => {
    h.tg.files.set('files/voice-1', Buffer.from('OggS-fake-opus'));
    h.nv.chatHandler = () => ({ chunks: [{ content: 'I\'m great, thanks for asking!' }] });
    await h.send(privateText('', { extra: { text: undefined, voice: { file_id: 'voice-1', file_unique_id: 'v', duration: 3, mime_type: 'audio/ogg' } } }));
    await h.settle();
    expect(h.nv.requests.some((r) => r.path.includes('/v1/audio/transcriptions'))).toBe(true);
    const lastUser = (h.nv.chatRequests()[0]!.messages as Array<{ content: string }>).at(-1)!;
    expect(lastUser.content).toContain('(voice message) hello alya, how are you');
    const md = finalRich()[0]!.markdown!;
    expect(md).toContain('<details><summary>🎙 What I heard</summary>');
    expect(h.nv.requests.some((r) => r.path.includes('/v1/audio/synthesize'))).toBe(true);
    const voice = h.tg.callsOf('sendVoice');
    expect(voice).toHaveLength(1);
    expect(String(voice[0]!.payload.voice)).toMatch(/<file:alya\.mp3/);
  });

  it('falls back to the omni model when the ASR endpoint fails', async () => {
    h.tg.files.set('files/voice-2', Buffer.from('OggS-fake'));
    h.nv.asrStatus = 404;
    h.nv.chatHandler = (b) => {
      const msgs = b.messages as Array<{ content: unknown }>;
      const first = msgs[0]!.content;
      if (Array.isArray(first)) return { chunks: [{ content: 'transcribed by omni' }] };
      return { chunks: [{ content: 'Got it!' }] };
    };
    await h.send(privateText('', { extra: { text: undefined, voice: { file_id: 'voice-2', file_unique_id: 'v2', duration: 2 } } }));
    await h.settle();
    const omni = h.nv.chatRequests().find((r) => Array.isArray((r.messages as Array<{ content: unknown }>)[0]!.content))!;
    expect(omni.model).toBe(h.cfg.visionModel);
    const parts = (omni.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    expect(parts.some((p) => p.type === 'audio_url')).toBe(true);
    expect((omni.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false);
  });

  it('looks at a photo with the vision model before Alya answers', async () => {
    h.tg.files.set('files/photo-big', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    h.nv.chatHandler = (b) => {
      const msgs = b.messages as Array<{ content: unknown }>;
      if (Array.isArray(msgs[0]!.content)) return { chunks: [{ content: 'A grey cat sleeping on a laptop keyboard.' }] };
      return { chunks: [{ content: 'Your cat is just like Pelmeni!' }] };
    };
    await h.send(
      privateText('', {
        extra: {
          text: undefined,
          caption: 'look at my cat',
          photo: [
            { file_id: 'photo-small', file_unique_id: 's', width: 90, height: 90, file_size: 1000 },
            { file_id: 'photo-big', file_unique_id: 'b', width: 1280, height: 960, file_size: 90_000 },
          ],
        },
      }),
    );
    await h.settle();
    const vision = h.nv.chatRequests()[0]!;
    expect(vision.model).toBe(h.cfg.visionModel);
    const url = ((vision.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0]!.content.find((p) => p.type === 'image_url'))!.image_url!.url;
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const chat = h.nv.chatRequests()[1]!;
    const last = (chat.messages as Array<{ content: string }>).at(-1)!.content;
    expect(last).toContain('A grey cat sleeping on a laptop keyboard.');
    expect(last).toContain('look at my cat');
    expect(finalRich()[0]!.markdown).toContain('Pelmeni');
  });

  it('/imagine draws with FLUX and sends the photo', async () => {
    await h.send(privateText('/imagine a cat in a winter scarf'));
    await h.tg.waitFor((calls) => calls.some((c) => c.method === 'sendPhoto'));
    const genai = h.nv.requests.find((r) => r.path.includes('/genai/'))!;
    expect(genai.path).toContain('black-forest-labs/flux.1-schnell');
    expect((genai.body as { prompt: string }).prompt).toBe('a cat in a winter scarf');
    expect(String(h.tg.callsOf('sendPhoto')[0]!.payload.caption)).toContain('a cat in a winter scarf');
  });
});

describe('groups', () => {
  it('answers only when addressed: placeholder reply + rich edits + ⏹ button', async () => {
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Hi everyone!' }, { content: ' Nice to meet you.' }], delayMs: 150 });
    await h.send(groupText('random chatter without addressing'));
    await h.settle();
    expect(h.nv.chatRequests()).toHaveLength(0);
    expect(h.app.store.recentMessages('-100123:0', 5).map((m) => m.content)).toEqual(['random chatter without addressing']);

    await h.send(groupText('@alya_test_bot say hi', { messageId: 555 }));
    await h.settle();
    const placeholder = h.tg.callsOf('sendRichMessage')[0]!;
    expect((placeholder.payload.reply_parameters as { message_id: number }).message_id).toBe(555);
    const stopKb = placeholder.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(stopKb.inline_keyboard[0]![0]!.callback_data).toMatch(/^stop:/);
    const edits = h.tg.callsOf('editMessageText');
    const lastEdit = edits.at(-1)!;
    expect((lastEdit.payload.rich_message as { markdown: string }).markdown).toContain('Hi everyone! Nice to meet you.');
    // the model saw the group context with speaker names
    const msgs = h.nv.chatRequests()[0]!.messages as Array<{ role: string; content: string }>;
    expect(msgs.at(-1)!.content).toBe('[Rahul]: say hi');
    expect(msgs.some((m) => m.content.includes('random chatter'))).toBe(true);
    expect(h.tg.callsOf('sendRichMessageDraft')).toHaveLength(0);
  });

  it('answers ephemeral commands with ephemeral_message_parameters (Bot API 10.2/10.3)', async () => {
    await h.send(groupText('/settings', { extra: { message_id: 0, ephemeral_message_id: 31 } }));
    await h.settle();
    const sent = h.tg.callsOf('sendRichMessage')[0]!;
    expect(sent.payload.ephemeral_message_parameters).toEqual({ receiver_user_id: 42 });
    expect(sent.payload.reply_parameters).toEqual({ ephemeral_message_id: 31 });
    expect(JSON.stringify(sent.payload.rich_message)).toContain('Settings');
  });

  it('keeps personal screens out of the group when the command is not ephemeral', async () => {
    await h.send(groupText('/memory'));
    await h.settle();
    const sent = h.tg.callsOf('sendRichMessage')[0]!;
    expect(sent.payload.ephemeral_message_parameters).toBeUndefined();
    expect(JSON.stringify(sent.payload)).toContain('in private');
  });
});

describe('guest mode & inline mode', () => {
  it('guest mode: answerGuestQuery placeholder, then streamed edits via inline_message_id', async () => {
    h.nv.chatHandler = () => ({ chunks: [{ content: 'Guest answer ' }, { content: 'here.' }], delayMs: 100 });
    await h.send({
      guest_message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -555, type: 'supergroup', title: 'Other chat' },
        from: { id: 77, is_bot: false, first_name: 'Maya' },
        text: '@alya_test_bot what is 2+2?',
        guest_query_id: 'gq-1',
        guest_bot_caller_user: { id: 77, is_bot: false, first_name: 'Maya' },
        guest_bot_caller_chat: { id: -555, type: 'supergroup', title: 'Other chat' },
      },
    } as never);
    await h.settle();
    const answer = h.tg.callsOf('answerGuestQuery')[0]!;
    expect(answer.payload.guest_query_id).toBe('gq-1');
    const result = answer.payload.result as { type: string; input_message_content: { rich_message: { markdown: string } } };
    expect(result.type).toBe('article');
    expect(result.input_message_content.rich_message.markdown).toContain('💭');
    const edits = h.tg.callsOf('editMessageText');
    expect(edits.every((e) => e.payload.inline_message_id === 'guest-inline-1')).toBe(true);
    expect((edits.at(-1)!.payload.rich_message as { markdown: string }).markdown).toContain('Guest answer here.');
    const sys = (h.nv.chatRequests()[0]!.messages as Array<{ content: string }>)[0]!.content;
    expect(sys).toContain('guest mode');
    expect(h.tg.callsOf('sendMessage')).toHaveLength(0);
  });

  it('inline mode: "Ask Alya" result, then the chosen inline message is edited with the answer', async () => {
    await h.send({ inline_query: { id: 'iq1', from: { id: 42, is_bot: false, first_name: 'Rahul' }, query: 'capital of Japan?', offset: '' } } as never);
    await h.settle();
    const results = h.tg.callsOf('answerInlineQuery')[0]!.payload.results as Array<{ id: string; reply_markup?: unknown; input_message_content: { rich_message?: unknown } }>;
    const ask = results.find((r) => r.id.startsWith('ask:'))!;
    expect(ask.reply_markup).toBeDefined(); // needed for inline_message_id
    expect(ask.input_message_content.rich_message).toBeDefined();

    h.nv.chatHandler = () => ({ chunks: [{ content: 'Tokyo! 🗼' }] });
    await h.send({ chosen_inline_result: { result_id: ask.id, from: { id: 42, is_bot: false, first_name: 'Rahul' }, query: 'capital of Japan?', inline_message_id: 'inl-42' } } as never);
    await h.settle();
    const edit = h.tg.callsOf('editMessageText').at(-1)!;
    expect(edit.payload.inline_message_id).toBe('inl-42');
    expect((edit.payload.rich_message as { markdown: string }).markdown).toContain('Tokyo!');
  });
});

describe('screens, settings and callbacks', () => {
  it('/start shows the rich welcome screen with one primary button and a party effect for new users', async () => {
    await h.send(privateText('/start'));
    await h.settle();
    const sent = h.tg.callsOf('sendRichMessage')[0]!;
    expect(sent.payload.message_effect_id).toBe('5046509860389126442');
    const blocks = (sent.payload.rich_message as { blocks: Array<{ type: string }> }).blocks;
    expect(blocks.map((b) => b.type)).toEqual(expect.arrayContaining(['heading', 'paragraph', 'table', 'details', 'footer']));
    const buttons = (sent.payload.reply_markup as { inline_keyboard: Array<Array<{ style?: string }>> }).inline_keyboard.flat();
    expect(buttons.filter((b) => b.style === 'primary')).toHaveLength(1);
  });

  it('settings: toggling voice updates the DB and re-renders with a disabled current choice', async () => {
    await h.send(privateText('/settings'));
    await h.settle();
    const msg = h.tg.callsOf('sendRichMessage')[0]!;
    const kb = (msg.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; disabled?: object }>> }).inline_keyboard;
    expect(kb[0]!.find((b) => b.disabled)?.text).toBe('✓ 🎙 Auto');
    await h.send({
      callback_query: {
        id: 'cb1',
        from: { id: 42, is_bot: false, first_name: 'Rahul' },
        chat_instance: 'x',
        data: 'set:voice:always',
        message: { message_id: 100, date: 0, chat: { id: 42, type: 'private', first_name: 'Rahul' } },
      },
    } as never);
    await h.settle();
    expect(h.app.store.getUser(42)?.settings.voice).toBe('always');
    const edit = h.tg.callsOf('editMessageText').at(-1)!;
    const kb2 = (edit.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; disabled?: object }>> }).inline_keyboard;
    expect(kb2[0]!.find((b) => b.disabled)?.text).toBe('✓ 🔊 Always');
    expect(h.tg.callsOf('answerCallbackQuery')).toHaveLength(1);
  });

  it('about screen includes a map block of Saint Petersburg', async () => {
    await h.send(privateText('/about'));
    await h.settle();
    const blocks = (h.tg.callsOf('sendRichMessage')[0]!.payload.rich_message as { blocks: Array<{ type: string; location?: { latitude: number } }> }).blocks;
    const map = blocks.find((b) => b.type === 'map')!;
    expect(Math.round(map.location!.latitude)).toBe(60);
  });

  it('regenerate edits the same message in place', async () => {
    h.nv.chatHandler = (_b, i) => ({ chunks: [{ content: i === 0 ? 'first try' : 'second try' }] });
    await h.send(privateText('hello'));
    await h.settle();
    const sent = h.tg.callsOf('sendRichMessage')[0]!;
    const replyId = ((sent.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data).split(':')[1];
    await h.send({
      callback_query: { id: 'cb2', from: { id: 42, is_bot: false, first_name: 'Rahul' }, chat_instance: 'x', data: `rg:${replyId}`, message: { message_id: 100, date: 0, chat: { id: 42, type: 'private', first_name: 'Rahul' } } },
    } as never);
    await h.settle();
    const edits = h.tg.callsOf('editMessageText').filter((e) => e.payload.message_id === 100);
    expect((edits.at(-1)!.payload.rich_message as { markdown: string }).markdown).toContain('second try');
    const assistant = h.app.store.recentMessages('42:0', 10).filter((m) => m.role === 'assistant');
    expect(assistant.map((m) => m.content)).toEqual(['second try']);
  });

  it('memory screen deletes a single fact', async () => {
    h.app.store.upsertUser({ id: 42, first_name: 'Rahul' });
    h.app.store.addMemory(42, 'Loves mango lassi', 'test', 50);
    const id = h.app.store.listMemories(42)[0]!.id;
    await h.send({
      callback_query: { id: 'cb3', from: { id: 42, is_bot: false, first_name: 'Rahul' }, chat_instance: 'x', data: `mem:del:${id}:0`, message: { message_id: 7, date: 0, chat: { id: 42, type: 'private', first_name: 'Rahul' } } },
    } as never);
    await h.settle();
    expect(h.app.store.listMemories(42)).toHaveLength(0);
  });
});

describe('reminders', () => {
  it('delivers due reminders with snooze/done buttons (success style on Done)', async () => {
    h.app.store.upsertUser({ id: 42, first_name: 'Rahul' });
    h.app.store.addReminder({ userId: 42, chatId: 42, text: 'drink water', dueAt: Date.now() - 1000 });
    const n = await deliverDueReminders(h.app);
    expect(n).toBe(1);
    const sent = h.tg.callsOf('sendRichMessage')[0]!;
    expect(JSON.stringify(sent.payload.rich_message)).toContain('drink water');
    const buttons = (sent.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; style?: string }>> }).inline_keyboard.flat();
    expect(buttons.find((b) => b.text.includes('Done'))?.style).toBe('success');
    expect(await deliverDueReminders(h.app)).toBe(0); // never twice
  });
});
