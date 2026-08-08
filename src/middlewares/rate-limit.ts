import type { Context, Next } from 'hono';
import { llmConfig } from '../config/llm';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory rate limit (per-process). Fine for local/docker single node.
 * ponytail: ceiling = multi-instance needs Redis; upgrade path: shared store.
 */
export function rateLimit(options?: { limit?: number; windowMs?: number; keyPrefix?: string }) {
  const limit = options?.limit ?? llmConfig.rateLimitPerMinute;
  const windowMs = options?.windowMs ?? 60_000;
  const keyPrefix = options?.keyPrefix ?? 'rl';

  return async (c: Context, next: Next) => {
    const userId = c.get('userId') as number | undefined;
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const key = `${keyPrefix}:${userId ?? ip}:${c.req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      return c.json(
        { success: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' },
        429
      );
    }
    await next();
  };
}
