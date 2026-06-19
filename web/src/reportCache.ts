import type { SelfReportResponse } from './api.js';

// Cache the self-report in the browser so reopening the "My report" tab (or
// reloading the page) shows the last result instantly instead of re-running a
// ~150-call GitHub scan. Auto-refreshes once the cache is older than the TTL;
// a manual Rescan always refetches.
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const KEY_PREFIX = 'ghhc:self-report:';

interface Cached {
  fetchedAt: number;
  data: SelfReportResponse;
}

function cacheKey(login: string): string {
  return `${KEY_PREFIX}${login}`;
}

export interface CachedReport {
  data: SelfReportResponse;
  fetchedAt: number;
  stale: boolean;
}

export function readCachedReport(login: string): CachedReport | null {
  try {
    const raw = localStorage.getItem(cacheKey(login));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (!parsed?.data || typeof parsed.fetchedAt !== 'number') return null;
    return {
      data: parsed.data,
      fetchedAt: parsed.fetchedAt,
      stale: Date.now() - parsed.fetchedAt > TTL_MS,
    };
  } catch {
    return null;
  }
}

export function writeCachedReport(login: string, data: SelfReportResponse): number {
  const fetchedAt = Date.now();
  try {
    localStorage.setItem(cacheKey(login), JSON.stringify({ fetchedAt, data } satisfies Cached));
  } catch {
    // localStorage may be unavailable/full — caching is best-effort.
  }
  return fetchedAt;
}

// Clear cached reports (all of them on sign-out, or one login's).
export function clearCachedReport(login?: string): void {
  try {
    if (login) {
      localStorage.removeItem(cacheKey(login));
      return;
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}
