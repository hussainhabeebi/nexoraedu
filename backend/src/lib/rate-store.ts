/**
 * express-rate-limit store kept in D1, so sign-in, MFA, refresh and password-reset limits hold across all
 * Cloudflare Worker instances (an in-memory store would be per instance). One atomic UPSERT per hit.
 * Expired rows are removed by the daily cron (jobs/scheduler.ts).
 */
import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import { d1 } from './prisma';

export class D1Store implements Store {
  windowMs = 60_000;
  localKeys = false;
  constructor(public prefix: string) {}
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    const row = await d1()
      .prepare(
        `INSERT INTO "_rate_limits" ("key", "hits", "resetAt") VALUES (?, 1, ?)
         ON CONFLICT ("key") DO UPDATE SET
           "hits" = CASE WHEN "resetAt" <= ? THEN 1 ELSE "hits" + 1 END,
           "resetAt" = CASE WHEN "resetAt" <= ? THEN excluded."resetAt" ELSE "resetAt" END
         RETURNING "hits", "resetAt"`,
      )
      .bind(this.prefix + key, now + this.windowMs, now, now)
      .first<{ hits: number; resetAt: number }>();
    return { totalHits: row!.hits, resetTime: new Date(row!.resetAt) };
  }
  async decrement(key: string) {
    await d1().prepare(`UPDATE "_rate_limits" SET "hits" = max("hits" - 1, 0) WHERE "key" = ?`).bind(this.prefix + key).run();
  }
  async resetKey(key: string) {
    await d1().prepare(`DELETE FROM "_rate_limits" WHERE "key" = ?`).bind(this.prefix + key).run();
  }
  async resetAll() {
    await d1().prepare(`DELETE FROM "_rate_limits" WHERE "key" LIKE ?`).bind(this.prefix + '%').run();
  }
}

export async function purgeExpiredRateLimits() {
  await d1().prepare(`DELETE FROM "_rate_limits" WHERE "resetAt" < ?`).bind(Date.now()).run();
}

/**
 * Best-effort per-instance store for the general API limiter (no timers: Workers forbid them at start-up).
 * The strict limits (sign-in, MFA, refresh, password reset, public forms) use D1Store; Cloudflare's WAF
 * rate-limiting rule protects the whole API at the edge.
 */
export class InstanceMemoryStore implements Store {
  windowMs = 60_000;
  private hits = new Map<string, { n: number; resetAt: number }>();
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, (h = { n: 0, resetAt: now + this.windowMs }));
    h.n++;
    return { totalHits: h.n, resetTime: new Date(h.resetAt) };
  }
  async decrement(key: string) {
    const h = this.hits.get(key);
    if (h) h.n = Math.max(0, h.n - 1);
  }
  async resetKey(key: string) {
    this.hits.delete(key);
  }
}
