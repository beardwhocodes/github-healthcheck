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
  isAdmin: boolean;
  suspended: boolean;
  suspendedReason: string | null;
}

// ── Admin + support domain types (mirror the Worker responses) ─────────────
export type Role = 'user' | 'admin';
export type MessageStatus = 'open' | 'read' | 'resolved';
export type ReportStatus = 'reported' | 'reviewing' | 'confirmed' | 'dismissed' | 'takendown';
export type AbuseCategory = 'malware' | 'impersonation';
export type VelocityBand = 'normal' | 'warn' | 'abuse';

export interface ContactMessage {
  id: string;
  login: string;
  email: string | null;
  subject: string;
  body: string;
  status: MessageStatus;
  adminReply: string | null;
  repliedAt: number | null;
  createdAt: number;
}

// The durable user record as the server stores it (matches UserRecord). The
// single-user detail endpoint returns exactly this.
export interface AdminUserBase {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
  suspendedAt: number | null;
  suspendedReason: string | null;
  suspendedBy: string | null;
  includesPrivate: number;
  scanCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

// A row in the admin Users LIST, augmented by the server with the trailing-24h
// scan count and its velocity band. These two fields are list-only.
export interface AdminUser extends AdminUserBase {
  recentScans: number;
  velocity: VelocityBand;
}

export interface ScanLogItem {
  kind: string;
  target: string | null;
  topScore: number | null;
  createdAt: number;
}

// A row in the global scan-audit feed (every user's scans).
export interface ScanAuditItem extends ScanLogItem {
  login: string;
}

// A distinct scanned target, aggregated across all users.
export interface TopScannedItem {
  target: string;
  kind: string;
  scans: number;
  scanners: number;
  lastScanned: number;
}

export interface AdminReport {
  id: string;
  reporterLogin: string;
  suspectRepo: string;
  suspectUrl: string | null;
  sourceRepo: string | null;
  confidence: number | null;
  category: AbuseCategory | null;
  status: ReportStatus;
  adminNotes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry {
  id: string;
  adminLogin: string;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: number;
}

export interface DayCount {
  day: string;
  count: number;
}

export interface AdminStats {
  generatedAt: number;
  users: {
    total: number;
    suspended: number;
    admins: number;
    active7d: number;
    active30d: number;
    new7d: number;
    newToday: number;
  };
  scans: {
    total: number;
    last24h: number;
    last7d: number;
    byKind: Record<string, number>;
    perDay: DayCount[];
  };
  messages: { open: number; read: number; resolved: number; total: number };
  reports: {
    total: number;
    byStatus: Record<string, number>;
    topReported: { suspectRepo: string; reporters: number }[];
  };
}

export interface ReportLogInput {
  suspectRepo: string;
  suspectUrl?: string | null;
  sourceRepo?: string | null;
  confidence?: number | null;
  category?: AbuseCategory | null;
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
  // Only present on the POST (subscribe) response: whether the confirmation
  // email actually sent. false means the subscription is pending but we couldn't
  // email the link.
  verificationSent?: boolean;
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
  // POST (server now rejects GET): these trigger work + a scan-log write, so
  // they must not be drivable by a SameSite=Lax link-click. `target` stays a
  // query param to preserve the existing request shape.
  scan: (target: string) =>
    send<ScanResponse>(`/api/scan?target=${encodeURIComponent(target)}`, 'POST'),
  clones: () => send<ClonesResponse>('/api/clones', 'POST'),
  alerts: () => get<AlertsStatus>('/api/alerts'),
  subscribe: (email: string) => send<AlertsStatus>('/api/alerts', 'POST', { email }),
  unsubscribe: () => send<AlertsStatus>('/api/alerts', 'DELETE'),
  logout: () => send<{ ok: boolean }>('/auth/logout', 'POST'),
  // Permanently erase the account: revokes the GitHub OAuth grant, deletes all
  // stored rows (sessions, alerts, scans, messages, reports), destroys the session.
  deleteAccount: () => send<{ ok: boolean }>('/api/me', 'DELETE'),

  // Support / reporting (any signed-in user).
  submitContact: (input: { subject: string; body: string; email?: string }) =>
    send<{ ok: boolean; id: string }>('/api/contact', 'POST', input),
  myMessages: () => get<{ messages: ContactMessage[] }>('/api/contact'),
  reportRepo: (input: ReportLogInput) => send<{ ok: boolean }>('/api/reports', 'POST', input),

  // Admin surface (server returns 404 to non-admins).
  admin: {
    // Pass the viewer's UTC offset so calendar-day metrics align to their local
    // timezone (getTimezoneOffset(): minutes to add to local to reach UTC).
    stats: (tzOffsetMinutes = new Date().getTimezoneOffset()) =>
      get<AdminStats>(`/api/admin/stats?tzOffset=${tzOffsetMinutes}`),
    scans: (kind?: string) =>
      get<{ scans: ScanAuditItem[] }>(
        `/api/admin/scans${kind && kind !== 'all' ? `?kind=${encodeURIComponent(kind)}` : ''}`,
      ),
    topScans: () => get<{ targets: TopScannedItem[] }>('/api/admin/scans/top'),
    users: (params?: { query?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.query) qs.set('query', params.query);
      if (params?.status && params.status !== 'all') qs.set('status', params.status);
      const suffix = qs.toString() ? `?${qs}` : '';
      return get<{ users: AdminUser[] }>(`/api/admin/users${suffix}`);
    },
    user: (login: string) =>
      get<{ user: AdminUserBase; recentScans: ScanLogItem[] }>(
        `/api/admin/users/${encodeURIComponent(login)}`,
      ),
    // These mutations return the durable user record (AdminUserBase) — they do
    // NOT carry the list-only recentScans/velocity fields. The caller merges the
    // returned base onto the existing list row rather than replacing it.
    suspend: (login: string, reason: string) =>
      send<{ user: AdminUserBase }>(`/api/admin/users/${encodeURIComponent(login)}/suspend`, 'POST', {
        reason,
      }),
    unsuspend: (login: string) =>
      send<{ user: AdminUserBase }>(`/api/admin/users/${encodeURIComponent(login)}/unsuspend`, 'POST'),
    setRole: (login: string, role: Role) =>
      send<{ user: AdminUserBase }>(`/api/admin/users/${encodeURIComponent(login)}/role`, 'POST', {
        role,
      }),
    messages: (status?: string) =>
      get<{ messages: ContactMessage[] }>(
        `/api/admin/messages${status && status !== 'all' ? `?status=${status}` : ''}`,
      ),
    updateMessage: (id: string, patch: { status?: MessageStatus; reply?: string }) =>
      send<{ message: ContactMessage }>(`/api/admin/messages/${encodeURIComponent(id)}`, 'POST', patch),
    reports: (status?: string) =>
      get<{ reports: AdminReport[] }>(
        `/api/admin/reports${status && status !== 'all' ? `?status=${status}` : ''}`,
      ),
    updateReport: (id: string, patch: { status?: ReportStatus; notes?: string }) =>
      send<{ report: AdminReport }>(`/api/admin/reports/${encodeURIComponent(id)}`, 'POST', patch),
    audit: (category?: string, limit = 200) =>
      get<{ entries: AuditEntry[] }>(
        `/api/admin/audit?limit=${limit}${category && category !== 'all' ? `&category=${category}` : ''}`,
      ),
  },
};

export function loginUrl(includePrivate: boolean): string {
  return `/auth/login${includePrivate ? '?include_private=1' : ''}`;
}
