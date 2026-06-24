# Plan 002: `auth/crypto.ts` has direct unit tests

> **Executor instructions**: Follow step by step; run every verification command
> and confirm its expected result before moving on. Honor "STOP conditions".
> When done, update plan 002's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/auth/crypto.ts`
> If `src/auth/crypto.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (adds tests only; no production code changes)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

`src/auth/crypto.ts` is the single most security-critical module in the repo: it
encrypts GitHub OAuth access tokens at rest in D1 (AES-GCM), signs the OAuth
`state` (HMAC, the CSRF defense), and hashes session ids. It has **zero direct
tests** — the integration suite only uses `encrypt`/`sha256Hex` as seeding
helpers and never asserts on their output. A silent regression here — a
round-trip break (locks every user out), a tampered-ciphertext that decrypts, a
tampered signature that `verify` accepts, or the AES/HMAC key domain-separation
collapsing — would ship undetected. These are pure functions; testing them is
cheap and high-value.

## Current state

- `src/auth/crypto.ts` — Web Crypto helpers. Public surface to test:
  - `encrypt(plaintext, secret): Promise<string>` → `"ivB64.ctB64"`, AES-GCM,
    fresh random 12-byte IV (line 44).
  - `decrypt(payload, secret): Promise<string>` → throws `'malformed
    ciphertext'` if no `.` (line 55); otherwise AES-GCM decrypt (throws on a bad
    GCM tag / wrong key).
  - `sign(value, secret): Promise<string>` → `"value.sigB64"` (HMAC-SHA256).
  - `verify(signed, secret): Promise<string | null>` → returns `value` if the
    signature checks out, else `null` (line 84–97; splits on the **last** `.`).
  - `sha256Hex(value): Promise<string>` → lowercase hex SHA-256.
  - `randomToken(bytes=32): string` → base64url (the chars `+/=` are stripped/
    replaced, line 23).
  - AES and HMAC keys are domain-separated by hashing `${secret}:aes-gcm:v1` vs
    `${secret}:hmac:v1` (lines 37, 67).
- Test conventions: unit tests live in `tests/*.spec.ts`, run by `pnpm test`
  (vitest, **node** environment per `vitest.config.ts`). Node 22 provides
  `globalThis.crypto`/`crypto.subtle`, so these run with no extra setup. Model
  the file's structure on `tests/scan-stats.spec.ts` (`import { describe, expect,
  it } from 'vitest'` + nested `describe`/`it`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass, incl. new file |
| Run just this file | `pnpm test -- crypto` | the new tests pass |

## Scope

**In scope**: `tests/crypto.spec.ts` (create).
**Out of scope**: `src/auth/crypto.ts` and every other source file — this plan
adds tests only. If a test reveals a real bug, STOP and report it (do not fix it
here).

## Git workflow

- Branch: `advisor/002-test-auth-crypto`
- One commit, e.g. `Test: cover auth/crypto AES-GCM + HMAC round-trips and tampering`.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Write `tests/crypto.spec.ts`

Create the file importing from `../src/auth/crypto.js`. Cover these cases (use
`await` — every fn except `randomToken` is async):

**`encrypt`/`decrypt`**
- round-trip: `decrypt(await encrypt('hello-token', S), S)` === `'hello-token'`.
- non-determinism: two `encrypt` calls of the same input differ (random IV).
- wrong secret: `decrypt(ciphertext, 'other-secret')` **rejects** (use
  `await expect(...).rejects.toThrow()`).
- tampered ciphertext: take `await encrypt('x', S)`, flip a character in the
  ciphertext half (after the `.`), assert `decrypt` **rejects** (GCM auth tag).
- malformed: `decrypt('no-dot', S)` rejects with `/malformed/`.
- unicode: a multi-byte string (e.g. `'tøken-✓-😀'`) round-trips intact.

**`sign`/`verify`**
- `verify(await sign('s:1', S), S)` === `'s:1'`.
- tampered value: sign `'s:1'`, replace the value part, assert `verify` returns
  `null`.
- wrong secret: a value signed with `S` → `verify(signed, 'other')` is `null`.
- a value that contains a `.` (e.g. `'a.b.c'`) still round-trips (verify splits
  on the **last** dot).

**Domain separation (public-API-observable)**
- `verify(await encrypt('v', S), S)` is `null` — an AES ciphertext is not a
  valid HMAC signature (the two key derivations don't interchange).

**`sha256Hex`**
- known vector: `sha256Hex('abc')` ===
  `'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`.
- stable: same input → same output; different input → different.

**`randomToken`**
- contains none of `+`, `/`, `=` (base64url).
- two calls differ.

**Verify**: `pnpm test -- crypto` → all new tests pass.

### Step 2: Full suite still green

**Verify**: `pnpm test` → exit 0; `pnpm typecheck` → exit 0.

## Test plan

- One new file `tests/crypto.spec.ts`, ~15 assertions across the groups above.
- Structural pattern: `tests/scan-stats.spec.ts`.
- Verification: `pnpm test` → all pass including the new file.

## Done criteria

- [ ] `pnpm test` exits 0; `tests/crypto.spec.ts` exists and passes
- [ ] `pnpm typecheck` exits 0
- [ ] The tampered-ciphertext and tampered-signature cases assert rejection/`null` (not just round-trips)
- [ ] `git status` shows only `tests/crypto.spec.ts` created
- [ ] `plans/README.md` row for 002 updated

## STOP conditions

- A test that *should* pass on correct crypto fails (e.g. round-trip fails, or
  `decrypt` does NOT reject tampered input) — that means a real crypto bug;
  STOP and report it rather than weakening the test to make it green.
- `crypto.subtle` is undefined in the test runtime — STOP (Node version / env
  problem, not this plan).

## Maintenance notes

- If `crypto.ts` ever changes the ciphertext format (`iv.ct`) or the key
  derivation strings (`:aes-gcm:v1` / `:hmac:v1`), these tests pin the current
  contract and will (correctly) fail — update them deliberately and consider a
  versioned-decrypt migration so existing stored tokens still decrypt.
- A reviewer should confirm no real secret/token value is hardcoded — use
  obvious dummy strings only.
