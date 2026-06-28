import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The Worker (src/index.ts) and the static-asset runtime (web/public/_headers)
// each carry their OWN copy of the Content-Security-Policy — one for the
// /api,/auth,/email responses, one for the SPA assets. They MUST stay
// byte-identical or a browser sees two different policies depending on which
// surface served the response. Both files document the keep-in-sync contract in
// a comment; this test enforces it so a future edit to one can't silently drift.

const indexUrl = new URL('../src/index.ts', import.meta.url);
const headersUrl = new URL('../web/public/_headers', import.meta.url);

// Reconstruct the joined CSP from the `const CSP = [ ... ].join('; ')` array in
// index.ts by pulling each double-quoted directive in source order.
function cspFromIndex(): string {
  const src = readFileSync(indexUrl, 'utf8');
  const block = src.match(/const CSP = \[([\s\S]*?)\]\.join\('; '\)/);
  if (!block?.[1]) throw new Error('could not locate the CSP array in src/index.ts');
  const directives = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return directives.join('; ');
}

// Pull the Content-Security-Policy value from the _headers file.
function cspFromHeaders(): string {
  const src = readFileSync(headersUrl, 'utf8');
  const line = src.split('\n').find((l) => /^\s*Content-Security-Policy:/i.test(l));
  if (!line) throw new Error('could not locate Content-Security-Policy in web/public/_headers');
  return line.replace(/^\s*Content-Security-Policy:\s*/i, '').trim();
}

describe('CSP parity (src/index.ts ↔ web/public/_headers)', () => {
  it('extracts a non-trivial policy from each source', () => {
    // Guard the extractors themselves: if either returns '' the equality check
    // below would pass vacuously and the parity guarantee would be worthless.
    expect(cspFromIndex()).toContain("default-src 'self'");
    expect(cspFromHeaders()).toContain("default-src 'self'");
  });

  it('the worker CSP and the static-asset CSP are byte-identical', () => {
    expect(cspFromIndex()).toBe(cspFromHeaders());
  });
});
