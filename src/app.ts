/** Dependency container shared by handlers, the engine and the scheduler. */
import type { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Senses } from './ai/services.js';
import type { NvidiaClient } from './ai/nvidia.js';
import type { Config } from './config.js';
import type { Store } from './db/store.js';
import type { Renderer } from './rich/render.js';
import type { ActiveRegistry } from './chat/active.js';

export interface Flags {
  toolsBroken: boolean;
  maintenance: boolean;
}

export interface App {
  cfg: Config;
  store: Store;
  ai: NvidiaClient;
  senses: Senses;
  api: Api;
  me: UserFromGetMe;
  renderer: Renderer;
  active: ActiveRegistry;
  flags: Flags;
  /** conv → last reply that still shows action buttons (removed when a newer reply arrives). */
  lastReply: Map<string, { chatId: number; messageId: number }>;
  startedAt: number;
}

export function chatModel(app: App): string {
  return app.store.getKv('chat_model') || app.cfg.chatModel;
}

export function isMaintenance(app: App): boolean {
  return app.flags.maintenance || app.store.getKv('maintenance') === '1';
}
