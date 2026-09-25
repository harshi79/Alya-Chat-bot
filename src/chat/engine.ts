/**
 * The conversation engine: builds Alya's context, streams the NVIDIA answer
 * into a sink, runs tools, finalizes, persists, and fires side effects.
 */
import { InputFile } from 'grammy';
import type { User } from 'grammy/types';
import { chatModel, type App } from '../app.js';
import { AIError, extractLeakedToolCalls, type ChatMessage, type ToolCall } from '../ai/nvidia.js';
import { imagePromptProblem } from '../ai/services.js';
import { runTool, toolDefs, type Deferred, type ToolEnv, type ToolOutcome } from '../ai/tools.js';
import { logger } from '../log.js';
import { buildSystemPrompt, type ChatKind } from '../persona/alya.js';
import { lines } from '../persona/lines.js';
import { voiceEmotion } from '../persona/mood.js';
import { sanitizeModelMarkdown } from '../rich/sanitize.js';
import { tgDescription } from '../util/tgerrors.js';
import { truncate } from '../util/text.js';
import { dayKey } from '../util/time.js';
import type { ActiveGen } from './active.js';
import { maybeMaintainMemory, maybeTitleTopic } from './memory.js';
import { actionKeyboard, chooseThinking, stopNote } from './policy.js';
import type { Delivered, Sink, StreamView } from './sinks.js';

const log = logger('engine');

export interface TurnRequest {
  kind: ChatKind;
  from: User;
  chatId: number | null;
  chatTitle?: string;
  threadId?: number;
  conv: string;
  /** Text given to the model for this turn (media already turned into descriptions). */
  userText: string;
  /** Markdown appended to the delivered answer only (e.g. a transcript <details>). */
  extras?: string[];
  sink: Sink;
  gen: ActiveGen;
  mode: 'normal' | 'regenerate' | 'deep';
  persistUser: boolean;
  userMessageId?: number;
  voiceIn?: boolean;
  classic: boolean;
  effect?: string;
  /** Status shown before the first token (e.g. "Listening…"). */
  status?: string;
  /** Called after the sink started (e.g. to run ASR/vision while the draft shows a status). */
  prepare?: (update: (status: string) => void, signal: AbortSignal) => Promise<string | null>;
}

export interface TurnResult {
  text: string;
  delivered?: Delivered;
  stopped: boolean;
  failed: boolean;
  replyId?: string;
}

function historyToMessages(app: App, req: TurnRequest, excludeLastUser: boolean): ChatMessage[] {
  const rows = app.store.recentMessages(req.conv, app.cfg.historyMessages);
  if (excludeLastUser && rows.length && rows[rows.length - 1]?.role === 'user') rows.pop();
  const out: ChatMessage[] = [];
  for (const r of rows) {
    const content = req.kind === 'group' && r.role === 'user' && r.name ? `[${r.name}]: ${r.content}` : r.content;
    const prev = out[out.length - 1];
    if (prev && prev.role === r.role && typeof prev.content === 'string') prev.content = `${prev.content}\n${content}`;
    else out.push({ role: r.role, content });
  }
  // Some chat templates reject a conversation that starts with an assistant turn
  // (e.g. Alya greeted first via "Let's talk") — anchor it instead of dropping it.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(the chat started — Alya spoke first)' });
  return out;
}

async function runDeferred(app: App, req: TurnRequest, items: Deferred[]): Promise<void> {
  if (req.chatId === null) return;
  const chatId = req.chatId;
  for (const d of items) {
    try {
      if (d.type === 'dice') {
        await app.api.sendDice(chatId, d.emoji, { message_thread_id: req.threadId });
      } else if (d.type === 'quiz') {
        await app.api.sendPoll(
          chatId,
          d.question,
          d.options.map((text) => ({ text })),
          {
            message_thread_id: req.threadId,
            type: 'quiz',
            is_anonymous: false,
            correct_option_ids: d.correct,
            allows_multiple_answers: d.correct.length > 1 ? true : undefined,
            explanation: d.explanation,
          },
        );
      } else if (d.type === 'image') {
        const problem = imagePromptProblem(d.prompt);
        if (problem) {
          await app.api.sendMessage(chatId, 'Ты что?! I\'m not drawing that 😤', { message_thread_id: req.threadId });
          continue;
        }
        const day = dayKey(new Date(), app.cfg.defaultTimezone);
        if (app.cfg.dailyImageLimit > 0 && app.store.getUsage(day, req.from.id, 'image') >= app.cfg.dailyImageLimit && !app.cfg.adminIds.includes(req.from.id)) {
          await app.api.sendMessage(chatId, lines.imageLimit(), { message_thread_id: req.threadId });
          continue;
        }
        void app.api.sendChatAction(chatId, 'upload_photo', { message_thread_id: req.threadId }).catch(() => undefined);
        const img = await app.senses.generateImage(d.prompt);
        await app.api.sendPhoto(chatId, new InputFile(img.image, img.mime === 'image/png' ? 'alya.png' : 'alya.jpg'), {
          message_thread_id: req.threadId,
          caption: `🎨 ${truncate(d.prompt, 200)}`,
        });
        app.store.incUsage(day, req.from.id, 'image');
        app.store.incStat('images');
      }
    } catch (err) {
      log.warn(`deferred ${d.type} failed: ${err instanceof AIError ? err.message : tgDescription(err)}`);
      if (d.type === 'image') {
        const msg = err instanceof AIError && /safety|blocked/i.test(err.message) ? 'The art filter said no 🙈 Let\'s try something else?' : 'My drawing failed 😣 Try again in a bit?';
        await app.api.sendMessage(chatId, msg, { message_thread_id: req.threadId }).catch(() => undefined);
      }
    }
  }
}

/** Send the reply as a voice note too (voice mode). */
export async function sendVoiceReply(app: App, chatId: number, text: string, opts: { threadId?: number; replyTo?: number; userId: number }): Promise<boolean> {
  const day = dayKey(new Date(), app.cfg.defaultTimezone);
  if (app.cfg.dailyVoiceLimit > 0 && app.store.getUsage(day, opts.userId, 'voice') >= app.cfg.dailyVoiceLimit && !app.cfg.adminIds.includes(opts.userId)) return false;
  void app.api.sendChatAction(chatId, 'record_voice', { message_thread_id: opts.threadId }).catch(() => undefined);
  const { audio, seconds } = await app.senses.synthesize(text, voiceEmotion(new Date()));
  await app.api.sendVoice(chatId, new InputFile(audio, 'alya.mp3'), {
    message_thread_id: opts.threadId,
    duration: seconds,
    reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
  });
  app.store.incUsage(day, opts.userId, 'voice');
  app.store.incStat('voice_replies');
  return true;
}

export async function runTurn(app: App, req: TurnRequest): Promise<TurnResult> {
  const signal = req.gen.controller.signal;
  const now = new Date();
  const user = app.store.getUser(req.from.id);
  const settings = user?.settings;
  const view: StreamView = { content: '', reasoning: '', status: req.status ?? (req.mode === 'deep' ? lines.deepThinking() : lines.thinking()), startedAt: Date.now() };
  let stopped = false;
  let failed = false;

  try {
    await req.sink.start(view.status);
  } catch (err) {
    log.warn(`sink start failed: ${tgDescription(err)}`);
    req.sink.close();
    return { text: '', stopped: false, failed: true };
  }

  // Media processing (ASR / vision) happens while the user already sees a status.
  let userText = req.userText;
  if (req.prepare) {
    try {
      const extra = await req.prepare((status) => {
        view.status = status;
        req.sink.update({ ...view });
      }, signal);
      if (extra === null) {
        req.sink.close();
        return { text: '', stopped: false, failed: true };
      }
      userText = extra;
    } catch (err) {
      const aborted = signal.aborted;
      if (!aborted) log.warn(`prepare failed: ${(err as Error).message}`);
      await req.sink.fail(aborted ? stopNote() : lines.aiDown()).catch(() => undefined);
      return { text: '', stopped: aborted, failed: !aborted };
    }
  }

  if (!app.ai.enabled) {
    await req.sink.fail(lines.noKey()).catch(() => undefined);
    return { text: '', stopped: false, failed: true };
  }

  // ---- context
  const tz = user?.timezone ?? null;
  // Long-term memories are private: only inject them where nobody else can read the answer.
  const memories = req.kind === 'private' ? app.store.listMemories(req.from.id).map((m) => m.fact) : [];
  const summary = req.kind === 'private' || req.kind === 'group' ? app.store.getSummary(req.conv)?.summary : undefined;
  const reminders =
    req.kind === 'private'
      ? app.store
          .pendingReminders(req.from.id)
          .slice(0, 5)
          .map((r) => `#${r.id} "${r.text}" at ${new Date(r.due_at).toISOString().slice(0, 16)} UTC`)
      : [];
  const canDraw = req.kind === 'private' || req.kind === 'group';
  const toolsOn = app.cfg.toolsEnabled && !app.flags.toolsBroken;
  const system = buildSystemPrompt({
    now,
    kind: req.kind,
    userName: req.from.first_name || 'friend',
    nickname: settings?.nickname,
    bond: user?.bond ?? 0,
    streak: user?.streak ?? 0,
    daysTalked: user?.days_talked ?? 0,
    timezone: tz,
    memories,
    summary,
    reminders,
    groupTitle: req.chatTitle,
    classic: req.classic,
    tools: toolsOn,
    canDraw,
    canVoice: true,
    isNewUser: (user?.messages ?? 0) <= 1 && req.kind === 'private',
  });

  const history = historyToMessages(app, req, req.mode !== 'normal');
  const currentContent = req.kind === 'group' ? `[${req.from.first_name}]: ${userText}` : userText;
  if (req.persistUser) app.store.addMessage({ conv: req.conv, role: 'user', content: userText, name: req.from.first_name, userId: req.from.id, tgMessageId: req.userMessageId ?? null });
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: currentContent }];

  const { thinking, budget } = chooseThinking(userText, settings?.brain ?? 'auto', req.mode === 'deep');
  const env: ToolEnv = {
    kind: req.kind,
    userId: req.from.id,
    chatId: req.chatId,
    threadId: req.threadId,
    timezone: tz,
    now,
    store: app.store,
    cfg: app.cfg,
    canDraw,
    deferred: [],
  };
  const outcomes: ToolOutcome[] = [];
  let tools = toolsOn ? toolDefs(req.kind, canDraw) : undefined;

  // ---- generation (up to 3 rounds when tools need a follow-up)
  try {
    for (let round = 0; round < 3; round++) {
      let roundContent = '';
      let toolCalls: ToolCall[] = [];
      try {
        const stream = app.ai.stream(
          {
            model: chatModel(app),
            messages,
            tools,
            thinking,
            reasoningBudget: budget,
            max_tokens: app.cfg.maxTokens + (thinking ? (budget ?? 2048) : 0),
          },
          { signal, priority: 'high' },
        );
        for await (const ev of stream) {
          if (ev.type === 'content') {
            roundContent += ev.text;
            view.content += ev.text;
          } else if (ev.type === 'reasoning') {
            view.reasoning += ev.text;
          } else if (ev.type === 'reclassify') {
            view.reasoning += roundContent;
            view.content = view.content.slice(0, view.content.length - roundContent.length);
            roundContent = '';
          } else if (ev.type === 'done') {
            toolCalls = ev.toolCalls;
            if (ev.usage?.total_tokens) app.store.incStat('tokens', ev.usage.total_tokens);
          }
          req.sink.update({ ...view });
        }
      } catch (err) {
        if (round === 0 && tools && err instanceof AIError && err.kind === 'bad_request' && err.mentionsTools) {
          log.warn(`tools rejected by the API (${err.message}) — disabling tools for this process`);
          app.flags.toolsBroken = true;
          tools = undefined;
          round--;
          continue;
        }
        throw err;
      }

      const leaked = extractLeakedToolCalls(roundContent);
      if (leaked.calls.length) {
        view.content = view.content.slice(0, view.content.length - roundContent.length) + leaked.text;
        roundContent = leaked.text;
        toolCalls = [...toolCalls, ...leaked.calls];
      }
      if (!toolCalls.length) break;

      const results = toolCalls.map((c) => {
        const o = runTool(c, env);
        outcomes.push(o);
        return { call: c, outcome: o };
      });
      app.store.incStat('tool_calls', results.length);
      if (roundContent.trim()) break; // the answer is already written — tools were fire-and-forget
      // Follow-up round so Alya can talk about the tool results.
      view.status = results.find((r) => r.outcome.status)?.outcome.status ?? view.status;
      req.sink.update({ ...view });
      messages.push({ role: 'assistant', content: roundContent || null, tool_calls: toolCalls });
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id, name: r.call.function.name, content: JSON.stringify(r.outcome.result) });
    }
  } catch (err) {
    const e = err instanceof AIError ? err : new AIError('server', (err as Error)?.message ?? String(err));
    if (e.kind === 'aborted' || signal.aborted) {
      stopped = true;
    } else {
      log.warn(`generation failed: ${e.message}`);
      if (!view.content.trim()) {
        failed = true;
        const text = e.kind === 'rate' ? lines.rateLimited() : e.kind === 'disabled' || e.kind === 'auth' ? lines.noKey() : e.kind === 'timeout' ? lines.timeout() : lines.aiDown();
        await req.sink.fail(text).catch(() => undefined);
        app.store.incStat('errors');
        return { text: '', stopped: false, failed: true };
      }
      view.content += '\n\n_…(connection interrupted)_';
    }
  }

  // ---- final assembly
  let answer = sanitizeModelMarkdown(view.content);
  if (stopped && !answer) {
    await req.sink.fail(stopNote()).catch(() => undefined);
    return { text: '', stopped: true, failed: false };
  }
  if (!answer) answer = env.deferred.length ? '✨' : lines.empty();
  const notes = outcomes.map((o) => o.note).filter((n): n is string => Boolean(n));
  const body = [answer, ...notes].join('\n\n') + (stopped ? `\n\n${stopNote()}` : '');
  const extras: string[] = [...(req.extras ?? [])];
  if (settings?.showThoughts && view.reasoning.trim() && req.kind === 'private') {
    const thoughts = sanitizeModelMarkdown(truncate(view.reasoning.trim(), 3000)).replace(/<\/?details>|<\/?summary>/gi, '');
    extras.push(`<details><summary>💭 How I thought about it</summary>\n\n${thoughts}\n\n</details>`);
  }
  const markdown = [body, ...extras].join('\n\n');

  const withButtons = req.kind === 'private' || req.kind === 'group';
  const replyId = withButtons
    ? app.store.saveReply({
        chat_id: req.chatId,
        thread_id: req.threadId ?? null,
        user_id: req.from.id,
        message_id: null,
        inline_message_id: null,
        conv: req.conv,
        prompt: userText,
        text: body,
      })
    : undefined;
  const keyboard = replyId ? actionKeyboard(replyId, { voice: Boolean(app.cfg.ttsFunctionId), deep: req.kind === 'private' && req.mode !== 'deep' }) : undefined;

  let delivered: Delivered | undefined;
  try {
    delivered = await req.sink.finalize({ markdown, keyboard, effect: settings?.effects === false ? undefined : req.effect });
  } catch (err) {
    log.error(`final delivery failed: ${tgDescription(err)}`);
    failed = true;
  }

  // ---- persist
  app.store.addMessage({ conv: req.conv, role: 'assistant', content: body, tgMessageId: delivered?.primaryMessageId ?? null });
  app.store.incStat('replies');
  if (req.chatId !== null) app.store.incUsage(dayKey(now, app.cfg.defaultTimezone), req.from.id, 'reply');
  if (replyId && delivered?.primaryMessageId) {
    app.store.updateReply(replyId, { message_id: delivered.primaryMessageId });
    const prev = app.lastReply.get(req.conv);
    if (prev && req.chatId !== null && prev.messageId !== delivered.primaryMessageId) {
      void app.api.editMessageReplyMarkup(prev.chatId, prev.messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    }
    if (req.chatId !== null) app.lastReply.set(req.conv, { chatId: req.chatId, messageId: delivered.primaryMessageId });
  }

  // ---- side effects (after the text is visible)
  if (env.deferred.length && !stopped) await runDeferred(app, req, env.deferred);
  const wantsVoice = req.chatId !== null && withButtons && !stopped && !failed && ((req.voiceIn && settings?.voice === 'auto') || settings?.voice === 'always');
  if (wantsVoice && app.cfg.ttsFunctionId) {
    try {
      await sendVoiceReply(app, req.chatId as number, body, { threadId: req.threadId, replyTo: delivered?.primaryMessageId, userId: req.from.id });
    } catch (err) {
      log.warn(`voice reply failed: ${(err as Error).message}`);
    }
  }
  if (!stopped && !failed && (req.kind === 'private' || req.kind === 'group')) {
    void maybeMaintainMemory(app, req.conv, req.from.id, req.kind).catch((err) => log.debug(`memory: ${(err as Error).message}`));
    if (req.kind === 'private' && req.threadId && req.chatId !== null) {
      void maybeTitleTopic(app, req.chatId, req.threadId, userText, body).catch((err) => log.debug(`title: ${(err as Error).message}`));
    }
  }
  return { text: body, delivered, stopped, failed, replyId };
}
