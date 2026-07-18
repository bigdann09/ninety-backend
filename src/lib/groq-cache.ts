/**
 * Shared cache + dedup + call-budget layer for anything that hits the Groq API.
 *
 * The free Groq tier rate-limits aggressively, and before this existed the /copilot
 * route fired a fresh Groq call on every single request with zero caching — the
 * frontend polls it every 6s per open match page, so one viewer alone was enough to
 * burn through the free-tier budget in minutes, and N viewers on the same match each
 * triggered their own independent call for what is functionally the same answer.
 *
 * This fixes both problems: per-key TTL caching (so concurrent viewers of the same
 * match share one result) and a global sliding-window call budget that falls back to
 * the last good cached value — or lets the caller's own heuristic fallback take over —
 * instead of ever queueing up a burst of calls against a rate-limited free API.
 */

type CacheEntry<T> = { value: T; expiresAt: number | null; computedAt: number };

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

const GROQ_MAX_CALLS_PER_WINDOW = Number(process.env.GROQ_MAX_CALLS_PER_MINUTE || 20);
const GROQ_WINDOW_MS = 60_000;
let callTimestamps: number[] = [];

function groqBudgetAvailable(): boolean {
  const now = Date.now();
  callTimestamps = callTimestamps.filter((t) => now - t < GROQ_WINDOW_MS);
  return callTimestamps.length < GROQ_MAX_CALLS_PER_WINDOW;
}

function recordGroqCall(): void {
  callTimestamps.push(Date.now());
}

/**
 * Runs `computeFn` (expected to call Groq) behind a cache keyed by `key`.
 * `ttlMs: null` caches forever — use this for finished/immutable data (e.g. a
 * full-time match's recap never changes, so it's computed once and never regenerated).
 *
 * Throws if the global budget is exhausted and there's no cached value to serve stale —
 * callers should already have a non-AI fallback for that case (see GroqService's
 * existing local-heuristic fallbacks), same as a normal Groq request failure.
 */
export async function cachedGroqCall<T>(
  key: string,
  ttlMs: number | null,
  computeFn: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  const isFresh = entry && (entry.expiresAt === null || entry.expiresAt > now);
  if (isFresh) return entry!.value;

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  if (!groqBudgetAvailable()) {
    if (entry) {
      console.warn(`[GroqCache] Budget exhausted (${GROQ_MAX_CALLS_PER_WINDOW}/min) — serving stale cache for "${key}"`);
      return entry.value;
    }
    throw new Error(`[GroqCache] Budget exhausted (${GROQ_MAX_CALLS_PER_WINDOW}/min) and no cached fallback for "${key}"`);
  }

  const promise = (async () => {
    try {
      recordGroqCall();
      const value = await computeFn();
      cache.set(key, { value, expiresAt: ttlMs === null ? null : now + ttlMs, computedAt: now });
      return value;
    } catch (err) {
      // Don't poison the cache on failure — but if we have a stale value, prefer it
      // over letting the error propagate, same spirit as the budget-exhausted path.
      if (entry) {
        console.warn(`[GroqCache] compute failed for "${key}", serving stale cache:`, (err as Error).message);
        return entry.value;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}
