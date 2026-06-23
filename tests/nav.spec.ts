import { describe, expect, it } from 'vitest';

import type { Me } from '../web/src/api.js';
import { TAB_PATH, pathToTab, tabsFor } from '../web/src/nav.js';

describe('pathToTab', () => {
  it('maps known section paths to their tab', () => {
    expect(pathToTab('/')).toBe('self');
    expect(pathToTab('/clones')).toBe('clones');
    expect(pathToTab('/scan')).toBe('scan');
    expect(pathToTab('/alerts')).toBe('alerts');
    expect(pathToTab('/contact')).toBe('contact');
    expect(pathToTab('/admin')).toBe('admin');
  });

  it('ignores a trailing slash', () => {
    expect(pathToTab('/clones/')).toBe('clones');
  });

  it('falls back to the root section for unknown or sub paths', () => {
    expect(pathToTab('/nope')).toBe('self');
    expect(pathToTab('/admin/users')).toBe('self');
  });

  it('round-trips every tab through its path', () => {
    for (const [tab, path] of Object.entries(TAB_PATH)) {
      expect(pathToTab(path)).toBe(tab);
    }
  });
});

describe('tabsFor', () => {
  const base: Me = {
    login: 'octocat',
    name: null,
    avatarUrl: '',
    scopes: '',
    includesPrivate: false,
    isAdmin: false,
    suspended: false,
    suspendedReason: null,
  };

  it('gives a normal user the scan sections + contact, no admin', () => {
    expect(tabsFor(base).map((t) => t.id)).toEqual([
      'self',
      'clones',
      'scan',
      'alerts',
      'contact',
    ]);
  });

  it('adds the admin section for admins', () => {
    expect(tabsFor({ ...base, isAdmin: true }).map((t) => t.id)).toContain('admin');
  });

  it('shows a suspended user only contact', () => {
    expect(tabsFor({ ...base, suspended: true }).map((t) => t.id)).toEqual(['contact']);
  });
});
