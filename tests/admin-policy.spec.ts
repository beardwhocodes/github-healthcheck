import { describe, expect, it } from 'vitest';

import {
  canSetRole,
  canSuspend,
  canUnsuspend,
  isAdminUser,
  isBootstrapAdmin,
  isValidMessageStatus,
  isValidReportStatus,
  isValidRole,
  resolveRole,
  scanVelocityBand,
  validateContact,
} from '../src/admin/policy.js';
import type { PolicyUser } from '../src/admin/policy.js';

const owner: PolicyUser = { login: 'copyjosh', role: 'admin' };
const otherAdmin: PolicyUser = { login: 'jane', role: 'admin' };
const normal: PolicyUser = { login: 'mallory', role: 'user' };

describe('isBootstrapAdmin / resolveRole', () => {
  it('recognizes the bootstrap admin case-insensitively', () => {
    expect(isBootstrapAdmin('copyjosh')).toBe(true);
    expect(isBootstrapAdmin('CopyJosh')).toBe(true);
    expect(isBootstrapAdmin('someoneelse')).toBe(false);
  });

  it('forces admin for the bootstrap login even if the row says user', () => {
    expect(resolveRole('copyjosh', 'user')).toBe('admin');
    expect(resolveRole('copyjosh', null)).toBe('admin');
  });

  it('honors the stored role for everyone else', () => {
    expect(resolveRole('jane', 'admin')).toBe('admin');
    expect(resolveRole('mallory', 'user')).toBe('user');
    expect(resolveRole('mallory', null)).toBe('user');
    expect(resolveRole('mallory', 'banana')).toBe('user');
  });

  it('isAdminUser combines stored role with the bootstrap override', () => {
    expect(isAdminUser({ login: 'copyjosh', role: 'user' })).toBe(true);
    expect(isAdminUser(otherAdmin)).toBe(true);
    expect(isAdminUser(normal)).toBe(false);
  });
});

describe('canSuspend', () => {
  it('lets an admin suspend a normal user', () => {
    expect(canSuspend(owner, normal).ok).toBe(true);
  });

  it('refuses a non-admin actor', () => {
    expect(canSuspend(normal, { login: 'bob', role: 'user' }).ok).toBe(false);
  });

  it('refuses self-suspension', () => {
    expect(canSuspend(owner, { login: 'copyjosh', role: 'admin' }).ok).toBe(false);
  });

  it('refuses suspending another admin', () => {
    expect(canSuspend(owner, otherAdmin).ok).toBe(false);
  });

  it('refuses suspending the bootstrap admin even if their row says user', () => {
    expect(canSuspend(otherAdmin, { login: 'copyjosh', role: 'user' }).ok).toBe(false);
  });
});

describe('canUnsuspend', () => {
  it('allows admins, refuses non-admins', () => {
    expect(canUnsuspend(owner).ok).toBe(true);
    expect(canUnsuspend(normal).ok).toBe(false);
  });
});

describe('canSetRole', () => {
  it('lets an admin promote a user', () => {
    expect(canSetRole(owner, normal, 'admin').ok).toBe(true);
  });

  it('refuses a non-admin actor', () => {
    expect(canSetRole(normal, { login: 'bob', role: 'user' }, 'admin').ok).toBe(false);
  });

  it('refuses an unknown role', () => {
    expect(canSetRole(owner, normal, 'superuser').ok).toBe(false);
  });

  it('refuses changing your own role (no self-lockout)', () => {
    expect(canSetRole(owner, { login: 'copyjosh', role: 'admin' }, 'user').ok).toBe(false);
  });

  it('refuses demoting the bootstrap admin', () => {
    expect(canSetRole(otherAdmin, { login: 'copyjosh', role: 'admin' }, 'user').ok).toBe(false);
  });
});

describe('status + role validators', () => {
  it('validates roles', () => {
    expect(isValidRole('admin')).toBe(true);
    expect(isValidRole('user')).toBe(true);
    expect(isValidRole('root')).toBe(false);
  });

  it('validates message statuses', () => {
    expect(isValidMessageStatus('open')).toBe(true);
    expect(isValidMessageStatus('resolved')).toBe(true);
    expect(isValidMessageStatus('deleted')).toBe(false);
  });

  it('validates report statuses', () => {
    expect(isValidReportStatus('takendown')).toBe(true);
    expect(isValidReportStatus('reported')).toBe(true);
    expect(isValidReportStatus('whatever')).toBe(false);
  });
});

describe('scanVelocityBand', () => {
  it('bands by trailing-24h scan count', () => {
    expect(scanVelocityBand(0)).toBe('normal');
    expect(scanVelocityBand(39)).toBe('normal');
    expect(scanVelocityBand(40)).toBe('warn');
    expect(scanVelocityBand(119)).toBe('warn');
    expect(scanVelocityBand(120)).toBe('abuse');
    expect(scanVelocityBand(10000)).toBe('abuse');
  });
});

describe('validateContact', () => {
  it('accepts and trims a good submission', () => {
    const r = validateContact({ subject: '  Help  ', body: '  My scan is stuck  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.subject).toBe('Help');
      expect(r.value.body).toBe('My scan is stuck');
    }
  });

  it('requires a subject', () => {
    expect(validateContact({ subject: '   ', body: 'enough text' }).ok).toBe(false);
  });

  it('rejects a too-short body', () => {
    expect(validateContact({ subject: 'Hi', body: 'no' }).ok).toBe(false);
  });

  it('rejects an over-long subject', () => {
    expect(validateContact({ subject: 'x'.repeat(161), body: 'enough text' }).ok).toBe(false);
  });

  it('rejects an over-long body', () => {
    expect(validateContact({ subject: 'Hi', body: 'x'.repeat(5001) }).ok).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(validateContact({ subject: 42, body: 'enough text' }).ok).toBe(false);
    expect(validateContact({ subject: 'Hi', body: null }).ok).toBe(false);
  });
});
