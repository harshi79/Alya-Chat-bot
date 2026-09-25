/**
 * Background memory work (low priority, light model):
 *   - extract new long-term facts about the user every few messages
 *   - condense old turns into a rolling summary
 *   - auto-title private-chat topics (Bot API 9.3/9.4 topics in private chats)
 */
import type { App } from '../app.js';
import { logger } from '../log.js';
import { MEMORY_PROMPT, SUMMARY_PROMPT, TITLE_PROMPT } from '../persona/alya.js';
import { truncate } from '../util/text.js';

const log = logger('memory');
const FACTS_EVERY = 8; // user+assistant messages between extractions
const busy = new Set<string>();

function transcript(rows: Array<{ role: string; name: string | null; content: string }>): string {
  return rows
    .map((r) => `${r.role === 'assistant' ? 'Alya' : r.name || 'User'}: ${truncate(r.content.replace(/\s+/g, ' '), 600)}`)
    .join('\n');
}

export async function maybeMaintainMemory(app: App, conv: string, userId: number, kind: 'private' | 'group'): Promise<void> {
  if (!app.ai.enabled || busy.has(conv)) return;
  busy.add(conv);
  try {
    // 1) facts (private chats only — group chatter is not about one person)
    if (kind === 'private') {
      const key = `facts_at:${conv}`;
      const lastId = Number(app.store.getKv(key) ?? '0');
      const recent = app.store.recentMessages(conv, 40).filter((m) => m.id > lastId);
      if (recent.length >= FACTS_EVERY) {
        const known = app.store.listMemories(userId).map((m) => `- ${m.fact}`).join('\n') || '(nothing yet)';
        const facts = await app.ai.completeJson<string[]>(
          {
            model: app.cfg.lightModel,
            messages: [
              { role: 'system', content: MEMORY_PROMPT },
              { role: 'user', content: `Already known:\n${known}\n\nConversation:\n${transcript(recent)}` },
            ],
            temperature: 0.2,
            max_tokens: 400,
          },
          { priority: 'low' },
        );
        let added = 0;
        if (Array.isArray(facts)) {
          for (const f of facts.slice(0, 6)) {
            if (typeof f === 'string' && app.store.addMemory(userId, f, 'auto', app.cfg.maxMemories) !== null) added++;
          }
        }
        app.store.setKv(key, String(recent[recent.length - 1]?.id ?? lastId));
        if (added) log.debug(`saved ${added} new facts for ${userId}`);
      }
    }

    // 2) rolling summary of turns that fell out of the history window
    const total = app.store.countMessages(conv);
    const window = app.cfg.historyMessages;
    if (total > window + 10) {
      const recentWindow = app.store.recentMessages(conv, window);
      const firstKept = recentWindow[0]?.id;
      const prev = app.store.getSummary(conv);
      if (firstKept !== undefined) {
        const old = app.store.messagesBetween(conv, prev?.upto_id ?? 0, firstKept);
        if (old.length >= 6) {
          const c = await app.ai.complete(
            {
              model: app.cfg.lightModel,
              messages: [
                { role: 'system', content: SUMMARY_PROMPT },
                { role: 'user', content: `${prev ? `Previous summary:\n${prev.summary}\n\n` : ''}Conversation to add:\n${transcript(old)}` },
              ],
              thinking: false,
              temperature: 0.3,
              max_tokens: 300,
            },
            { priority: 'low' },
          );
          if (c.content) app.store.setSummary(conv, truncate(c.content, 1200), old[old.length - 1]!.id);
        }
      }
    }
  } finally {
    busy.delete(conv);
  }
}

/** Give a fresh private-chat topic a cute title after its first exchange. */
export async function maybeTitleTopic(app: App, chatId: number, threadId: number, userText: string, reply: string): Promise<void> {
  const topic = app.store.getTopic(chatId, threadId);
  if (!topic || topic.titled) return;
  app.store.upsertTopic(chatId, threadId, null, true); // mark first so we never title twice
  const c = await app.ai.complete(
    {
      model: app.cfg.lightModel,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: `User: ${truncate(userText, 500)}\nAlya: ${truncate(reply, 500)}` },
      ],
      thinking: false,
      temperature: 0.7,
      max_tokens: 30,
    },
    { priority: 'low' },
  );
  const title = c.content.replace(/["'«»\n]/g, '').trim().slice(0, 60);
  if (!title) return;
  await app.api.editForumTopic(chatId, threadId, { name: title });
  app.store.upsertTopic(chatId, threadId, title, true);
}
