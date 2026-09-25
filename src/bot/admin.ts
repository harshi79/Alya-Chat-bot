/** Owner/admin commands: dashboard, broadcast, bans, model switch, avatar, maintenance. */
import { InputFile, type Bot, type Context } from 'grammy';
import { chatModel, isMaintenance, type App } from '../app.js';
import type { ConvQueue } from '../chat/queue.js';
import { isAdmin } from '../config.js';
import { logger } from '../log.js';
import { isBlockedByUser, isRateLimited, retryAfterSec, tgDescription } from '../util/tgerrors.js';
import { humanDuration } from '../util/text.js';
import { dayKey } from '../util/time.js';
import { downloadFile } from './media.js';
import { adminScreen, type AdminStats } from './screens.js';

const log = logger('admin');

export function collectStats(app: App, queue: ConvQueue<unknown>): AdminStats {
  return {
    users: app.store.countUsers(),
    groups: app.store.countGroups(),
    stats: app.store.getStats(),
    today: app.store.usageTotals(dayKey(new Date(), app.cfg.defaultTimezone)),
    uptime: humanDuration(Date.now() - app.startedAt),
    model: chatModel(app),
    queue: { active: queue.activeCount, pending: queue.pendingCount(), streaming: app.active.size, limiterFree: app.ai.limiter.available() },
    maintenance: isMaintenance(app),
    rich: app.renderer.richUnsupported ? 'classic (server lacks rich)' : 'rich (Bot API 10.3)',
  };
}

let broadcasting = false;

export function registerAdmin(bot: Bot, app: App, queue: ConvQueue<unknown>): void {
  const admins = bot.filter((ctx: Context) => isAdmin(ctx.from?.id, app.cfg));

  admins.command('admin', async (ctx) => {
    await app.renderer.sendScreen(ctx.chat.id, adminScreen(collectStats(app, queue)), { isPrivate: ctx.chat.type === 'private' });
  });

  admins.command('maintenance', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const on = arg === 'on' || (arg === '' && !isMaintenance(app));
    app.store.setKv('maintenance', on ? '1' : '0');
    app.flags.maintenance = on;
    await ctx.reply(on ? '🛠 Maintenance mode ON — only admins get replies.' : '✅ Maintenance mode OFF.');
  });

  admins.command('model', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) return ctx.reply(`Current chat model: ${chatModel(app)}\nUse /model <name> or /model reset`);
    if (arg === 'reset') app.store.delKv('chat_model');
    else app.store.setKv('chat_model', arg);
    await ctx.reply(`🤖 Chat model: ${chatModel(app)}`);
  });

  admins.command(['ban', 'unban'], async (ctx) => {
    const id = Number.parseInt(ctx.match.trim(), 10) || ctx.msg.reply_to_message?.from?.id;
    if (!id) return ctx.reply('Usage: /ban <user id> (or reply to a message)');
    const ban = ctx.msg.text?.startsWith('/ban') ?? false;
    if (!app.store.getUser(id)) app.store.upsertUser({ id, first_name: '' });
    app.store.setUserField(id, 'banned', ban ? 1 : 0);
    await ctx.reply(`${ban ? '🚫 Banned' : '✅ Unbanned'} ${id}`);
  });

  admins.command('avatar', async (ctx) => {
    const photo = ctx.msg.reply_to_message?.photo;
    if (!photo?.length) return ctx.reply('Reply to a photo with /avatar to make it my profile photo.');
    try {
      const biggest = [...photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
      const buf = await downloadFile(app, biggest.file_id, 10 * 1024 * 1024);
      await app.api.setMyProfilePhoto({ type: 'static', photo: new InputFile(buf, 'avatar.jpg') });
      await ctx.reply('✨ New profile photo set. Do I look cute? …Don\'t answer that.');
    } catch (err) {
      await ctx.reply(`Couldn't set the photo: ${tgDescription(err)}`);
    }
  });

  admins.command('broadcast', async (ctx) => {
    const src = ctx.msg.reply_to_message;
    if (!src) return ctx.reply('Reply to the message you want to broadcast with /broadcast.');
    if (broadcasting) return ctx.reply('A broadcast is already running.');
    broadcasting = true;
    const ids = app.store.listActiveUserIds();
    await ctx.reply(`📢 Broadcasting to ${ids.length} users…`);
    void (async () => {
      let ok = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          await app.api.copyMessage(id, ctx.chat.id, src.message_id);
          ok++;
        } catch (err) {
          if (isRateLimited(err)) {
            await new Promise((r) => setTimeout(r, (retryAfterSec(err) ?? 5) * 1000));
          }
          if (isBlockedByUser(err)) app.store.setUserField(id, 'blocked', 1);
          failed++;
        }
        await new Promise((r) => setTimeout(r, 45));
      }
      broadcasting = false;
      log.info(`broadcast done: ${ok} ok, ${failed} failed`);
      await app.api.sendMessage(ctx.chat.id, `📢 Broadcast finished: ${ok} delivered, ${failed} failed.`).catch(() => undefined);
    })();
  });
}
