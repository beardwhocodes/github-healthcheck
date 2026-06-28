import { describe, expect, it } from 'vitest';

import { extractUrls, findBinaryFilenameTokens } from '../src/engine/helpers.js';

// Regression guard for the O(n²) ReDoS that previously lived in the README
// URL-extraction and prose-filename regexes. Both are now linear.
//
// We assert completion rather than a fixed wall-clock budget: a fixed-ms
// threshold is flaky (CI load, GC) and proves nothing about asymptotic safety.
// Instead we feed a large adversarial input under a tight per-test timeout. At
// 1M chars a quadratic implementation does ~10^12 ops (minutes), so the prior
// backtracking pattern blows the timeout while the linear one finishes in ms —
// a deterministic pass/fail that scales with the actual complexity bug.
describe('engine regexes resist ReDoS on attacker-controlled READMEs', () => {
  // Generous for O(n) over 1M chars, impossible for the old O(n²) pattern.
  const TIMEOUT_MS = 2_000;
  const SIZE = 1_000_000;

  it(
    'extractUrls completes on a 1M-char unclosed markdown link',
    () => {
      const evil = `[x](${'a'.repeat(SIZE)}`; // open "(" then no closing ")"
      expect(Array.isArray(extractUrls(evil))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'findBinaryFilenameTokens completes on a 1M-char dotted run',
    () => {
      const evil = `${'a.'.repeat(SIZE / 2)}a`; // "a.a.a.…a" — no real extension
      expect(Array.isArray(findBinaryFilenameTokens(evil))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it('still extracts a normal markdown link and a binary filename', () => {
    expect(extractUrls('see [home](https://example.com/x) here')).toContain(
      'https://example.com/x',
    );
    expect(findBinaryFilenameTokens('download Setup.exe now')).toContain('setup.exe');
  });
});
