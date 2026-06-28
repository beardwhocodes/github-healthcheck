import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Codifies the documented hard rule: src/engine/ must stay PURE — no I/O, no
// clock/entropy, no Worker/Node globals, no reaching into the GitHub client.
// fs is fine *here* because this is a test, not engine code.

const ENGINE_DIR = fileURLToPath(new URL('../src/engine', import.meta.url));

function engineFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return engineFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

// Each rule names the impurity it forbids. Note: `new Date()` with NO arguments
// reads the wall clock and is banned; `new Date(isoString)` is deterministic
// date parsing and stays allowed (helpers.ts relies on it).
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: 'fetch(', pattern: /\bfetch\s*\(/ },
  { label: 'env. access', pattern: /\benv\./ },
  { label: 'process.', pattern: /\bprocess\./ },
  { label: 'Date.now', pattern: /\bDate\.now\b/ },
  { label: 'Math.random', pattern: /\bMath\.random\b/ },
  { label: 'new Date() (clock read)', pattern: /\bnew Date\(\s*\)/ },
  { label: "import from '../github'", pattern: /from\s+['"][^'"]*\/github(\/|['"])/ },
  { label: 'DB binding', pattern: /\bDB\b/ },
];

describe('engine purity', () => {
  const files = engineFiles(ENGINE_DIR);

  it('finds engine source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s contains no forbidden I/O tokens', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const { label, pattern } of FORBIDDEN) {
      expect(pattern.test(source), `${file} must not contain ${label}`).toBe(false);
    }
  });
});
