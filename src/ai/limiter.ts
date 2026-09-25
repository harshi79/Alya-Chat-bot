/**
 * Requests-per-minute limiter with priorities. NVIDIA's free tier allows ~40 RPM
 * per key; chat replies (high) always jump ahead of background work (low).
 */
export type Priority = 'high' | 'normal' | 'low';
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

interface Waiter {
  priority: Priority;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RateLimiter {
  private grants: number[] = [];
  private queue: Waiter[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private rpm: number,
    private windowMs = 60_000,
    private clock: () => number = Date.now,
  ) {}

  setRpm(rpm: number): void {
    this.rpm = Math.max(1, rpm);
    this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Remaining grants available right now. */
  available(): number {
    this.prune();
    return Math.max(0, this.rpm - this.grants.length);
  }

  acquire(priority: Priority = 'normal', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { priority, seq: this.seq++, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.queue = this.queue.filter((x) => x !== w);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.queue.push(w);
      this.queue.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq);
      this.pump();
    });
  }

  private prune(): void {
    const cutoff = this.clock() - this.windowMs;
    while (this.grants.length > 0 && (this.grants[0] as number) <= cutoff) this.grants.shift();
  }

  private pump(): void {
    this.prune();
    while (this.queue.length > 0 && this.grants.length < this.rpm) {
      const w = this.queue.shift() as Waiter;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.grants.push(this.clock());
      w.resolve();
    }
    if (this.queue.length > 0 && !this.timer) {
      const oldest = this.grants[0] ?? this.clock();
      const wait = Math.max(50, oldest + this.windowMs - this.clock() + 5);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref?.();
    }
  }
}

/** Sliding-window per-key counter (flood control). */
export class WindowCounter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
    private clock: () => number = Date.now,
  ) {}

  /** Records a hit; returns false when over the limit (hit is not recorded). */
  hit(key: string): boolean {
    const t = this.clock();
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.gc();
    return true;
  }

  private gc(): void {
    const cutoff = this.clock() - this.windowMs;
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((x) => x > cutoff);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
  }
}
