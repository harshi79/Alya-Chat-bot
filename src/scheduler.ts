/** Reminders delivery and housekeeping. */
import type { App } from './app.js';
import { reminderFireScreen } from './bot/screens.js';
import { logger } from './log.js';
import { isBlockedByUser, tgDescription } from './util/tgerrors.js';
import { dayKey } from './util/time.js';

const log = logger('scheduler');

export async function deliverDueReminders(app: App, now = Date.now()): Promise<number> {
  const due = app.store.dueReminders(now);
  let sent = 0;
  for (const r of due) {
    app.store.setReminderStatus(r.id, 'sent'); // claim first: never deliver twice
    try {
      const user = app.store.getUser(r.user_id);
      const isGroup = r.chat_id !== r.user_id;
      const screen = reminderFireScreen(r.text, r.id);
      if (isGroup) {
        // Mention the owner so the group reminder actually pings them.
        screen.blocks.unshift({ type: 'paragraph', text: [{ type: 'text_mention', text: `👋 ${user?.first_name ?? 'hey'}`, user: { id: r.user_id, is_bot: false, first_name: user?.first_name ?? 'friend' } }] });
      }
      await app.renderer.sendScreen(r.chat_id, screen, { threadId: r.thread_id ?? undefined, isPrivate: !isGroup, classic: user?.settings.classic });
      sent++;
    } catch (err) {
      log.warn(`reminder ${r.id} failed: ${tgDescription(err)}`);
      app.store.setReminderStatus(r.id, 'failed');
      if (isBlockedByUser(err) && r.chat_id === r.user_id) app.store.setUserField(r.user_id, 'blocked', 1);
    }
  }
  return sent;
}

export function housekeeping(app: App): void {
  app.store.pruneReplies(14 * 86_400_000);
  const cutoff = dayKey(new Date(Date.now() - 45 * 86_400_000), app.cfg.defaultTimezone);
  app.store.pruneUsage(cutoff);
  const pruned = app.store.pruneOldMessages(400);
  if (pruned) log.info(`pruned ${pruned} old messages`);
}

export function startScheduler(app: App): () => void {
  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    deliverDueReminders(app)
      .catch((err) => log.error('reminder tick failed', err))
      .finally(() => {
        busy = false;
      });
  }, 15_000);
  const hk = setInterval(() => {
    try {
      housekeeping(app);
    } catch (err) {
      log.error('housekeeping failed', err);
    }
  }, 3_600_000);
  tick.unref?.();
  hk.unref?.();
  return () => {
    clearInterval(tick);
    clearInterval(hk);
  };
}
