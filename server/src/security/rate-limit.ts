export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 单实例内存限流器（规格 §12：隧道有状态，单实例先行）。
 * 键由调用方组合（IP / 账号 / 会话），窗口为固定窗口。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): RateLimitDecision {
    const at = this.now();
    const bucket = this.buckets.get(key);

    if (bucket === undefined || bucket.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }

    if (bucket.count < limit) {
      bucket.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    }

    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)) };
  }

  reset(): void {
    this.buckets.clear();
  }
}
