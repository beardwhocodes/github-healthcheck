// Typed client for the Worker API. Domain types are imported straight from the
// detection engine so the UI and server never drift.
import type {
  AccountReport,
  CloneMatch,
  Finding,
  RepoReport,
  RiskBand,
  Severity,
} from '../../src/engine/types.js';

export type { AccountReport, CloneMatch, Finding, RepoReport, RiskBand, Severity };

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string;
  scopes: string;
  includesPrivate: boolean;
}

export interface SelfReportResponse {
  report: AccountReport;
  scanned: number;
  totalRepos: number;
}

export type ScanResponse =
  | { kind: 'repo'; report: RepoReport }
  | { kind: 'account'; report: AccountReport; scanned: number; totalRepos: number };

export interface ClonesResponse {
  sourcesScanned: number;
  sources: string[];
  matches: CloneMatch[];
}

export interface AlertsStatus {
  subscribed: boolean;
  // Subscribed but the email hasn't been confirmed yet (double opt-in pending).
  pending?: boolean;
  email: string | null;
  lastRunAt: number | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(path, { headers: { Accept: 'application/json' } });
  return handle<T>(resp);
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(resp);
}

async function handle<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(data.message ?? data.error ?? `Request failed (${resp.status})`, resp.status);
  }
  return (await resp.json()) as T;
}

export const api = {
  async me(): Promise<Me | null> {
    try {
      return await get<Me>('/api/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  selfReport: (limit?: number) =>
    get<SelfReportResponse>(`/api/report${limit ? `?limit=${limit}` : ''}`),
  scan: (target: string) => get<ScanResponse>(`/api/scan?target=${encodeURIComponent(target)}`),
  clones: () => get<ClonesResponse>('/api/clones'),
  alerts: () => get<AlertsStatus>('/api/alerts'),
  subscribe: (email: string) => send<AlertsStatus>('/api/alerts', 'POST', { email }),
  unsubscribe: () => send<AlertsStatus>('/api/alerts', 'DELETE'),
  logout: () => send<{ ok: boolean }>('/auth/logout', 'POST'),
};

export function loginUrl(includePrivate: boolean): string {
  return `/auth/login${includePrivate ? '?include_private=1' : ''}`;
}
