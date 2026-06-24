// Pure helper — no I/O. Normalizes a list of raw user-supplied watch targets
// (GitHub URLs, "owner/repo" strings) into canonical full names, enforcing a
// per-user maximum and rejecting anything that does not resolve to a single
// repo (account-level targets, invalid names, duplicates).
//
// Reuses parseTarget + isValidName from src/routes/scan.ts so the same URL
// formats accepted by the scan panel are accepted here.

import { parseTarget } from '../routes/scan.js';

export interface NormalizeResult {
  /** Canonical "owner/repo" strings, deduplicated, at most `max` entries. */
  ok: string[];
  /** Raw inputs that were rejected, with a reason. */
  rejected: { input: string; reason: string }[];
}

/**
 * Normalize raw watch-target strings into canonical "owner/repo" full names.
 *
 * Rules applied in order:
 * 1. Trim and skip blank inputs.
 * 2. `parseTarget` must return a non-null result of `kind: 'repo'`. Account-
 *    level inputs (single owner) are rejected — namespace watching is not
 *    supported (see proposal §1).
 * 3. Duplicates (case-insensitive) are collapsed: first occurrence wins.
 * 4. Entries beyond `max` are rejected with reason `'cap_exceeded'`.
 *
 * @param inputs  Raw strings from the user (URL, "owner/repo", etc.).
 * @param max     Hard cap on accepted entries (must be > 0).
 */
export function normalizeWatchTargets(
  inputs: string[],
  max: number,
): NormalizeResult {
  if (max <= 0) throw new RangeError('max must be > 0');

  const ok: string[] = [];
  const rejected: { input: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of inputs) {
    const input = raw.trim();
    if (!input) continue;

    const target = parseTarget(input);

    if (!target) {
      rejected.push({ input, reason: 'invalid_target' });
      continue;
    }

    if (target.kind === 'account') {
      rejected.push({ input, reason: 'account_target_not_supported' });
      continue;
    }

    const fullName = `${target.owner}/${target.name}`;
    const key = fullName.toLowerCase();

    if (seen.has(key)) {
      rejected.push({ input, reason: 'duplicate' });
      continue;
    }

    if (ok.length >= max) {
      rejected.push({ input, reason: 'cap_exceeded' });
      continue;
    }

    seen.add(key);
    ok.push(fullName);
  }

  return { ok, rejected };
}
