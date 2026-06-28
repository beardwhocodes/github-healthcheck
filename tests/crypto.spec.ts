import { describe, expect, it } from 'vitest';

import {
  decrypt,
  encrypt,
  randomToken,
  sha256Hex,
  sign,
  verify,
} from '../src/auth/crypto.js';

// Must be >= 32 chars: crypto now fails closed on weak SESSION_SECRET.
const S = 'test-secret-key-0123456789abcdef0123';
const S2 = 'another-secret-key-0123456789abcdef01';

// ---------------------------------------------------------------------------
// encrypt / decrypt
// ---------------------------------------------------------------------------
describe('encrypt / decrypt', () => {
  it('round-trips a plain ASCII string', async () => {
    const ct = await encrypt('hello world', S);
    expect(await decrypt(ct, S)).toBe('hello world');
  });

  it('two encrypts of the same input produce different ciphertexts (fresh IV)', async () => {
    const a = await encrypt('same', S);
    const b = await encrypt('same', S);
    expect(a).not.toBe(b);
  });

  it('round-trips a multi-byte unicode string', async () => {
    const emoji = '日本語テスト 🎉✔️';
    expect(await decrypt(await encrypt(emoji, S), S)).toBe(emoji);
  });

  it('rejects decryption with a different secret', async () => {
    const ct = await encrypt('secret data', S);
    await expect(decrypt(ct, S2)).rejects.toThrow();
  });

  it('rejects a tampered ciphertext (flipped char after the dot)', async () => {
    const ct = await encrypt('tamper me', S);
    const dotIdx = ct.indexOf('.');
    const flipped = ct.slice(0, dotIdx + 1) + (ct[dotIdx + 1] === 'A' ? 'B' : 'A') + ct.slice(dotIdx + 2);
    await expect(decrypt(flipped, S)).rejects.toThrow();
  });

  it('throws /malformed/ for a current-version payload with no dot', async () => {
    await expect(decrypt('v1:nodot', S)).rejects.toThrow(/malformed/);
  });

  it('returns null (not a throw) for an unknown or absent version marker', async () => {
    // A blob from a different scheme — caller treats null as "needs re-auth".
    expect(await decrypt('v2:abc.def', S)).toBeNull();
    expect(await decrypt('nodothere', S)).toBeNull();
  });

  it('prefixes the ciphertext with the version marker', async () => {
    expect(await encrypt('x', S)).toMatch(/^v1:/);
  });

  it('throws when SESSION_SECRET is shorter than 32 chars', async () => {
    await expect(encrypt('x', 'too-short-secret')).rejects.toThrow(/SESSION_SECRET/);
    await expect(decrypt(await encrypt('x', S), 'too-short-secret')).rejects.toThrow(
      /SESSION_SECRET/,
    );
  });
});

// ---------------------------------------------------------------------------
// sign / verify
// ---------------------------------------------------------------------------
describe('sign / verify', () => {
  it('verifies a correctly signed value', async () => {
    const signed = await sign('s:1', S);
    expect(await verify(signed, S)).toBe('s:1');
  });

  it('returns null when the value is tampered', async () => {
    const signed = await sign('original', S);
    const tampered = 'tampered' + signed.slice('original'.length);
    expect(await verify(tampered, S)).toBeNull();
  });

  it('returns null when verified with a different secret', async () => {
    const signed = await sign('value', S);
    expect(await verify(signed, S2)).toBeNull();
  });

  it('returns null (no throw) for a non-base64 signature segment', async () => {
    // Regression: fromBase64('@@@') used to throw OUTSIDE the verify .catch,
    // surfacing as a 500 for input like rs_oauth_state=foo.@@@.
    expect(await verify('foo.@@@', S)).toBeNull();
  });

  it('round-trips a value that itself contains dots (splits on last dot)', async () => {
    const value = 'a.b.c';
    const signed = await sign(value, S);
    expect(await verify(signed, S)).toBe('a.b.c');
  });

  it('returns null for a string with no dot', async () => {
    expect(await verify('nodot', S)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// domain separation: AES output is NOT a valid HMAC-signed token
// ---------------------------------------------------------------------------
describe('domain separation', () => {
  it('verify rejects an encrypt output as a signed token', async () => {
    const ct = await encrypt('v', S);
    expect(await verify(ct, S)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------
describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is stable across two calls', async () => {
    const a = await sha256Hex('stable');
    const b = await sha256Hex('stable');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    expect(await sha256Hex('aaa')).not.toBe(await sha256Hex('bbb'));
  });
});

// ---------------------------------------------------------------------------
// randomToken
// ---------------------------------------------------------------------------
describe('randomToken', () => {
  it('contains no +, /, or = characters (url-safe base64)', () => {
    for (let i = 0; i < 20; i++) {
      const t = randomToken();
      expect(t).not.toMatch(/[+/=]/);
    }
  });

  it('two calls produce different tokens', () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
