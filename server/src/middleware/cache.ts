import { Request, Response, NextFunction } from 'express';

interface CacheEntry {
  data: unknown;
  timestamp: number;
  ttl: number;
}

class MemoryCache {
  private cache: Map<string, CacheEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key: string, data: unknown, ttlMs: number = 300000): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

export const cache = new MemoryCache();

// Default TTL values in milliseconds
export const TTL = {
  SHORT: 60000,      // 1 minute - for latest/real-time data
  MEDIUM: 300000,    // 5 minutes - for aggregated data
  LONG: 1800000,     // 30 minutes - for historical/map data
  COUNTRIES: 3600000 // 1 hour - for static country list
};

/** Timestamp query params rounded down before keying, so the cache can hit. */
const TIME_PARAMS = ['start', 'end'];

/**
 * Cache key with timestamp params floored to a bucket.
 *
 * The client derives start/end from `new Date()` at millisecond precision, so
 * keying on the raw URL made every ranged request a unique key and the cache
 * never hit once.
 */
export function buildCacheKey(method: string, originalUrl: string, bucketMs: number): string {
  const qIndex = originalUrl.indexOf('?');
  if (qIndex === -1) return `${method}:${originalUrl}`;

  const path = originalUrl.slice(0, qIndex);
  const params = new URLSearchParams(originalUrl.slice(qIndex + 1));

  for (const p of TIME_PARAMS) {
    const raw = params.get(p);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    params.set(p, new Date(Math.floor(t / bucketMs) * bucketMs).toISOString());
  }

  params.sort();
  return `${method}:${path}?${params.toString()}`;
}

// Cache middleware factory
export function cacheMiddleware(ttlMs: number = TTL.MEDIUM) {
  const bucketMs = Math.min(60_000, ttlMs);
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = buildCacheKey(req.method, req.originalUrl, bucketMs);
    const cached = cache.get(key);

    if (cached) {
      res.json(cached);
      return;
    }

    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to cache the response
    res.json = (body: unknown) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, body, ttlMs);
      }
      return originalJson(body);
    };

    next();
  };
}
