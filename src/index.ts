/**
 * Alya — entry point.
 *   1. health server first (so hosting health checks pass immediately)
 *   2. bot (long polling, or webhook when WEBHOOK_URL is set)
 *   3. reminders scheduler
 */
import './util/quiet.js';
import { webhookCallback } from 'grammy';
import { ALLOWED_UPDATES, buildBot } from './bot/bot.js';
import { syncCommands } from './bot/commands.js';
import { chatModel } from './app.js';
import { config } from './config.js';
import { startHttpServer } from './health.js';
import { logger, setLogLevel } from './log.js';
import { startScheduler } from './scheduler.js';
import { sha256 } from './util/text.js';

const log = logger('main');
setLogLevel(config.logLevel);

async function main(): Promise<void> {
  const state: Record<string, unknown> = { status: 'starting' };
  const info = () => ({ service: 'alya-chat-bot', ...state, uptime_s: Math.round(process.uptime()) });

  if (!config.botToken) {
    startHttpServer(config.port, info);
    state.status = 'missing BOT_TOKEN';
    log.error('BOT_TOKEN is not set — the health server is running, but the bot is idle. Set BOT_TOKEN and restart.');
    return;
  }
  if (!config.nvidiaKey) log.warn('NVIDIA_API_KEY is not set — Alya will run, but cannot think. Get a free key at https://build.nvidia.com');

  const { bot, app, queue } = await buildBot(config);
  const username = bot.botInfo.username;
  Object.assign(state, {
    status: 'running',
    bot: `@${username}`,
    model: chatModel(app),
    nvidia: app.ai.enabled,
    guest_mode: Boolean(bot.botInfo.supports_guest_queries),
    topics: Boolean(bot.botInfo.has_topics_enabled),
  });

  const secret = config.webhookSecret || sha256(`alya:${config.botToken}`).slice(0, 48);
  let server;
  if (config.webhookUrl) {
    const path = `/telegram/${sha256(config.botToken).slice(0, 24)}`;
    const handle = webhookCallback(bot, 'http', { secretToken: secret, onTimeout: 'return', timeoutMilliseconds: 9_000 });
    server = startHttpServer(config.port, info, { path, handler: handle });
    await bot.api.setWebhook(`${config.webhookUrl}${path}`, {
      secret_token: secret,
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: false,
      max_connections: 40,
    });
    log.info(`webhook set → ${config.webhookUrl}${path}`);
  } else {
    server = startHttpServer(config.port, info);
  }

  if (config.syncCommands) void syncCommands(bot.api, { profile: config.syncProfile });
  const stopScheduler = startScheduler(app);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down`);
    state.status = 'stopping';
    stopScheduler();
    app.active.abortAll();
    try {
      if (!config.webhookUrl) await bot.stop();
    } catch {
      /* ignore */
    }
    await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 8_000))]);
    server?.close();
    app.store.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  log.info(`Alya is awake as @${username} · model ${chatModel(app)} · guest mode ${bot.botInfo.supports_guest_queries ? 'on' : 'off (enable in BotFather)'}`);
  if (!config.webhookUrl) {
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    await bot.start({ allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: true, onStart: () => log.info('long polling started') });
  }
}

process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
