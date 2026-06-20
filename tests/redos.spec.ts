import { describe, expect, it } from 'vitest';

import { extractUrls, findBinaryFilenameTokens } from '../src/engine/helpers.js';

// Regression guard for the O(n²) ReDoS that previously lived in the README
// URL-extraction and prose-filename regexes. Both are now linear; a 50k-char
// pathological input must parse near-instantly. (Pre-fix, the URL pattern took
// seconds on this shape.)
describe('engine regexes resist ReDoS on attacker-controlled READMEs', () => {
  const BUDGET_MS = 100;

  it('extractUrls stays fast on an unclosed markdown link', () => {
    const evil = `[x](${'a'.repeat(50_000)}`; // open "(" then 50k chars, no ")"
    const start = performance.now();
    extractUrls(evil);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });

  it('findBinaryFilenameTokens stays fast on a long dotted run', () => {
    const evil = `${'a.'.repeat(25_000)}a`; // "a.a.a.…a" — 50k chars, no real ext
    const start = performance.now();
    findBinaryFilenameTokens(evil);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });

  it('still extracts a normal markdown link and a binary filename', () => {
    expect(extractUrls('see [home](https://example.com/x) here')).toContain(
      'https://example.com/x',
    );
    expect(findBinaryFilenameTokens('download Setup.exe now')).toContain('setup.exe');
  });
});
