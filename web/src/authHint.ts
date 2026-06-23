// A non-sensitive hint, persisted in localStorage, of whether the last known
// session was signed in. It lets the very first paint choose between a spinner
// (likely a returning user) and the prerendered landing (likely a new/anonymous
// visitor) before the /api/me check resolves — avoiding a flash of the landing
// page for signed-in users. It is never trusted for access control; the server
// session is the only source of truth.
const KEY = 'gh_authed';

export function wasAuthed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setAuthed(value: boolean): void {
  try {
    if (value) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable (private mode, disabled) — the hint is optional.
  }
}
