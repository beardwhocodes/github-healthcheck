// Pure authorization + validation decisions for the admin back-end. No I/O, so
// every branch here is unit-tested directly (tests/admin-policy.spec.ts) — these
// are the security-critical decisions and must not depend on a mocked DB.

import {
  BOOTSTRAP_ADMIN_LOGINS,
  CONTACT_BODY_MAX,
  CONTACT_BODY_MIN,
  CONTACT_SUBJECT_MAX,
  MESSAGE_STATUSES,
  REPORT_STATUSES,
  ROLES,
  SCAN_VELOCITY_ABUSE,
  SCAN_VELOCITY_WARN,
} from './constants.js';
import type { MessageStatus, ReportStatus, Role } from './constants.js';

// The slice of a user record the policy layer needs to make a decision.
export interface PolicyUser {
  login: string;
  role: Role;
}

export interface Decision {
  ok: boolean;
  reason?: string;
}

const ALLOW: Decision = { ok: true };

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Logins that can never be demoted or suspended, regardless of stored role.
export function isBootstrapAdmin(login: string): boolean {
  const l = login.toLowerCase();
  return BOOTSTRAP_ADMIN_LOGINS.some((a) => a.toLowerCase() === l);
}

// The effective role for a login: bootstrap admins are admin no matter what the
// row says (covers a freshly re-seeded DB or a row that predates the role column).
export function resolveRole(login: string, storedRole: string | null | undefined): Role {
  if (isBootstrapAdmin(login)) return 'admin';
  return storedRole === 'admin' ? 'admin' : 'user';
}

export function isAdminUser(user: PolicyUser): boolean {
  return resolveRole(user.login, user.role) === 'admin';
}

// An admin may suspend another non-admin user. They may not suspend themselves,
// and may not suspend another admin (admins are mutually un-suspendable).
export function canSuspend(actor: PolicyUser, target: PolicyUser): Decision {
  if (!isAdminUser(actor)) return { ok: false, reason: 'Not authorized.' };
  if (sameLogin(actor.login, target.login)) return { ok: false, reason: 'You cannot suspend yourself.' };
  if (isAdminUser(target) || isBootstrapAdmin(target.login)) {
    return { ok: false, reason: 'Admins cannot be suspended.' };
  }
  return ALLOW;
}

// Unsuspend has the same gate minus the self-check (a no-op on self, but
// harmless); only admins may act, and there is nothing to protect on the target.
export function canUnsuspend(actor: PolicyUser): Decision {
  if (!isAdminUser(actor)) return { ok: false, reason: 'Not authorized.' };
  return ALLOW;
}

// Role changes: only admins; the requested role must be valid; you cannot change
// your own role (no self-demotion lockout); a bootstrap admin cannot be demoted.
export function canSetRole(actor: PolicyUser, target: PolicyUser, role: string): Decision {
  if (!isAdminUser(actor)) return { ok: false, reason: 'Not authorized.' };
  if (!isValidRole(role)) return { ok: false, reason: 'Unknown role.' };
  if (sameLogin(actor.login, target.login)) {
    return { ok: false, reason: 'You cannot change your own role.' };
  }
  if (isBootstrapAdmin(target.login) && role !== 'admin') {
    return { ok: false, reason: 'This account is a permanent admin.' };
  }
  return ALLOW;
}

export function isValidRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function isValidMessageStatus(status: string): status is MessageStatus {
  return (MESSAGE_STATUSES as readonly string[]).includes(status);
}

export function isValidReportStatus(status: string): status is ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(status);
}

export type VelocityBand = 'normal' | 'warn' | 'abuse';

export function scanVelocityBand(scansLast24h: number): VelocityBand {
  if (scansLast24h >= SCAN_VELOCITY_ABUSE) return 'abuse';
  if (scansLast24h >= SCAN_VELOCITY_WARN) return 'warn';
  return 'normal';
}

export interface ContactInput {
  subject?: unknown;
  body?: unknown;
}

export interface CleanContact {
  subject: string;
  body: string;
}

export type ContactValidation = { ok: true; value: CleanContact } | { ok: false; error: string };

// Validate + normalize a contact-form submission. Trims, enforces bounds, and
// rejects empties. Returns the cleaned values so callers store exactly this.
export function validateContact(input: ContactInput): ContactValidation {
  // Collapse CR/LF in the subject: it is later used as an email header
  // ("Re: <subject>") in admin replies, so newlines could attempt header
  // injection. The body may keep its line breaks (it's only an HTML/text body).
  const subject =
    typeof input.subject === 'string' ? input.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';

  if (!subject) return { ok: false, error: 'A subject is required.' };
  if (subject.length > CONTACT_SUBJECT_MAX) {
    return { ok: false, error: `Keep the subject under ${CONTACT_SUBJECT_MAX} characters.` };
  }
  if (body.length < CONTACT_BODY_MIN) return { ok: false, error: 'Please add a few more details.' };
  if (body.length > CONTACT_BODY_MAX) {
    return { ok: false, error: `Keep the message under ${CONTACT_BODY_MAX} characters.` };
  }
  return { ok: true, value: { subject, body } };
}
