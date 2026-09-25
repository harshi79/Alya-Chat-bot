/** Registry of running generations — for ⏹ stop buttons and stopped_message_generation. */
import { shortId } from '../util/text.js';

export interface ActiveGen {
  token: string;
  ownerId: number;
  conv: string;
  controller: AbortController;
  chatId?: number;
  draftId?: number;
  startedAt: number;
  stoppedBy?: 'user' | 'system';
}

export class ActiveRegistry {
  private byToken = new Map<string, ActiveGen>();
  private byDraft = new Map<string, string>();

  start(opts: { ownerId: number; conv: string; chatId?: number }): ActiveGen {
    const gen: ActiveGen = { token: shortId(), ownerId: opts.ownerId, conv: opts.conv, controller: new AbortController(), chatId: opts.chatId, startedAt: Date.now() };
    this.byToken.set(gen.token, gen);
    return gen;
  }

  bindDraft(gen: ActiveGen, chatId: number, draftId: number): void {
    gen.chatId = chatId;
    gen.draftId = draftId;
    this.byDraft.set(`${chatId}:${draftId}`, gen.token);
  }

  finish(gen: ActiveGen): void {
    this.byToken.delete(gen.token);
    if (gen.chatId !== undefined && gen.draftId !== undefined) this.byDraft.delete(`${gen.chatId}:${gen.draftId}`);
  }

  get(token: string): ActiveGen | undefined {
    return this.byToken.get(token);
  }

  /** Stop via inline ⏹ button. Only the owner (or an admin) may stop. */
  stopByToken(token: string, userId: number, isAdmin: boolean): 'stopped' | 'not_owner' | 'not_found' {
    const gen = this.byToken.get(token);
    if (!gen) return 'not_found';
    if (gen.ownerId !== userId && !isAdmin) return 'not_owner';
    gen.stoppedBy = 'user';
    gen.controller.abort(new Error('stopped by user'));
    return 'stopped';
  }

  /** Stop via Bot API 10.3 stopped_message_generation (draft_id may arrive as a string). */
  stopByDraft(chatId: number, draftId: number | string): boolean {
    const token = this.byDraft.get(`${chatId}:${Number(draftId)}`);
    const gen = token ? this.byToken.get(token) : undefined;
    if (!gen) return false;
    gen.stoppedBy = 'user';
    gen.controller.abort(new Error('stopped by user'));
    return true;
  }

  /** /stop — stop everything running in a conversation for this user. */
  stopConv(conv: string, userId: number): number {
    let n = 0;
    for (const gen of this.byToken.values()) {
      if (gen.conv === conv && gen.ownerId === userId) {
        gen.stoppedBy = 'user';
        gen.controller.abort(new Error('stopped by user'));
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.byToken.size;
  }

  abortAll(): void {
    for (const gen of this.byToken.values()) {
      gen.stoppedBy = 'system';
      gen.controller.abort(new Error('shutdown'));
    }
  }
}
