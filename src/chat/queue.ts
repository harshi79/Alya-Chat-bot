/**
 * Per-conversation serial queue with batching and a global parallelism cap.
 *
 * Handlers push work and return immediately (the grammY update loop never
 * blocks on AI). One conversation runs one turn at a time; items that pile up
 * while Alya is still typing are merged into her next turn when compatible —
 * like a person reading several texts at once.
 */
import { logger } from '../log.js';

const log = logger('queue');

export class ConvQueue<T> {
  private pending = new Map<string, T[]>();
  private running = new Set<string>();
  private waiting: Array<() => void> = [];
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly worker: (conv: string, batch: T[]) => Promise<void>,
    private readonly canMerge: (a: T, b: T) => boolean,
    private readonly maxParallel = 8,
    private readonly maxPendingPerConv = 20,
  ) {}

  push(conv: string, item: T): boolean {
    const list = this.pending.get(conv) ?? [];
    if (list.length >= this.maxPendingPerConv) return false;
    list.push(item);
    this.pending.set(conv, list);
    if (!this.running.has(conv)) void this.drain(conv);
    return true;
  }

  isBusy(conv: string): boolean {
    return this.running.has(conv);
  }

  pendingCount(conv?: string): number {
    if (conv) return this.pending.get(conv)?.length ?? 0;
    let n = 0;
    for (const l of this.pending.values()) n += l.length;
    return n;
  }

  get activeCount(): number {
    return this.inFlight;
  }

  /** Resolves when nothing is queued or running (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (this.running.size === 0 && this.pendingCount() === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private async slot(): Promise<void> {
    if (this.inFlight < this.maxParallel) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }

  private async drain(conv: string): Promise<void> {
    this.running.add(conv);
    try {
      for (;;) {
        const list = this.pending.get(conv);
        if (!list || list.length === 0) break;
        const first = list.shift() as T;
        const batch = [first];
        while (list.length > 0 && this.canMerge(first, list[0] as T)) batch.push(list.shift() as T);
        if (list.length === 0) this.pending.delete(conv);
        await this.slot();
        try {
          await this.worker(conv, batch);
        } catch (err) {
          log.error(`turn failed in ${conv}`, err);
        } finally {
          this.release();
        }
      }
    } finally {
      this.running.delete(conv);
      if (this.running.size === 0 && this.pendingCount() === 0) {
        const rs = this.idleResolvers.splice(0);
        for (const r of rs) r();
      }
    }
  }
}
