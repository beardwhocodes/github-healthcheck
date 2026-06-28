// Admin back-end vocabulary + bootstrap configuration. Pure data, no I/O — safe
// to import from both the Worker and (indirectly, via the engine boundary) tests.

// GitHub logins that are ALWAYS admins, re-promoted on every sign-in and
// protected from demotion/suspension — the "bootstrap admin" list. Sourced from
// the ADMIN_LOGINS env var (comma-separated) so the owner keeps access through a
// database reset or re-seed, while forks start with NO permanent superadmin
// (unset = empty). Parsing is pure string handling (no I/O), and the resulting
// list is threaded explicitly into the policy and user-store layers so those
// modules never read env directly. Additional admins can be promoted at runtime.
export function parseAdminLogins(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type Role = 'user' | 'admin';
export const ROLES: readonly Role[] = ['user', 'admin'];

export type ScanKind = 'self' | 'repo' | 'account' | 'clones';
export const SCAN_KINDS: readonly ScanKind[] = ['self', 'repo', 'account', 'clones'];

export type MessageStatus = 'open' | 'read' | 'resolved';
export const MESSAGE_STATUSES: readonly MessageStatus[] = ['open', 'read', 'resolved'];

export type ReportStatus = 'reported' | 'reviewing' | 'confirmed' | 'dismissed' | 'takendown';
export const REPORT_STATUSES: readonly ReportStatus[] = [
  'reported',
  'reviewing',
  'confirmed',
  'dismissed',
  'takendown',
];

export type AbuseCategory = 'malware' | 'impersonation';
export const ABUSE_CATEGORIES: readonly AbuseCategory[] = ['malware', 'impersonation'];

// Scan-velocity thresholds (scans in the trailing 24h) used to flag possible
// abuse in the admin Users view. Tuning lever, not an enforcement gate.
export const SCAN_VELOCITY_WARN = 40;
export const SCAN_VELOCITY_ABUSE = 120;

// Contact-form field bounds (defensive — also enforced client-side).
export const CONTACT_SUBJECT_MAX = 160;
export const CONTACT_BODY_MIN = 5;
export const CONTACT_BODY_MAX = 5000;
