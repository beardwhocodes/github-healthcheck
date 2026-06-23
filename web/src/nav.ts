import type { Me } from './api.js';

// The app's top-level sections. Each maps to a URL path so navigation is
// bookmarkable and works with browser back/forward.
export type Tab = 'self' | 'clones' | 'scan' | 'alerts' | 'contact' | 'admin';

// URL path for each section. 'self' (the user's own report) is the root.
export const TAB_PATH: Record<Tab, string> = {
  self: '/',
  clones: '/clones',
  scan: '/scan',
  alerts: '/alerts',
  contact: '/contact',
  admin: '/admin',
};

// Plain section name for the document <title> (no icons/emoji).
export const TAB_TITLE: Record<Tab, string> = {
  self: 'My report',
  clones: 'Clone detection',
  scan: 'Scan any repo',
  alerts: 'Alerts',
  contact: 'Contact',
  admin: 'Admin',
};

const PATH_TO_TAB: Record<string, Tab> = Object.fromEntries(
  Object.entries(TAB_PATH).map(([tab, path]) => [path, tab as Tab]),
) as Record<string, Tab>;

// Resolve a URL path to a section, ignoring a trailing slash. Unknown paths
// (including admin sub-paths, which aren't routed yet) fall back to the root.
export function pathToTab(pathname: string): Tab {
  const trimmed =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PATH_TO_TAB[trimmed] ?? 'self';
}

// The sections available to a user, in display order. Suspended users see only
// Contact; admins additionally see the Admin section.
export function tabsFor(me: Me): { id: Tab; label: string }[] {
  const scanTabs: { id: Tab; label: string }[] = me.suspended
    ? []
    : [
        { id: 'self', label: 'My report' },
        { id: 'clones', label: 'Clone detection' },
        { id: 'scan', label: 'Scan any repo' },
        { id: 'alerts', label: 'Alerts' },
      ];
  return [
    ...scanTabs,
    { id: 'contact', label: 'Contact' },
    ...(me.isAdmin ? [{ id: 'admin' as Tab, label: '⚙ Admin' }] : []),
  ];
}
