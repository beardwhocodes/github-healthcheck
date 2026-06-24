# Plan 005: The email page renderer escapes interpolated values by default

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 005's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/routes/email.ts`
> If it changed, compare the excerpts below to the live file; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

`src/routes/email.ts` renders the **public, unauthenticated** `/email/verify`
and `/email/unsubscribe` pages. Its `page(title, body, appUrl)` helper escapes
`title` and `appUrl` but interpolates `body` as **raw HTML by contract** —
callers must remember to escape. Today the only dynamic value reaching `body` is
`escapeHtml(sub.email)`, so it's safe. But `sub.email` is attacker-influenced
(it's whatever a user submitted to subscribe), so the moment any future caller
forgets to wrap a dynamic value, this becomes stored XSS on a public page. Make
the safe path the default so the footgun can't fire.

## Current state

- `src/routes/email.ts`:
  - The raw-by-contract helper (lines 50–68):
    ```ts
    // ... `body` is interpolated as RAW HTML so callers can include intentional
    // markup. CONTRACT: any dynamic/user-derived value placed in `body` MUST be
    // escaped by the caller ...
    function page(title: string, body: string, appUrl: string): string {
      return `...<p ...>${body}</p>...`;   // body is raw
    }
    function escapeHtml(s: string): string { /* &<>"' */ }
    ```
  - The one dynamic call site (lines 20–26):
    ```ts
    return c.html(page('Email confirmed ✓',
      `Alerts are now active for <strong>${escapeHtml(sub.email)}</strong>. ...`,
      c.env.APP_URL));
    ```
  - Three static call sites (lines 14–18, 32–35, 37–43) pass literal strings,
    some with intentional markup (none with dynamic data).
- Convention: this file already has `escapeHtml`; we keep it and add a tagged
  template so interpolations are escaped automatically while static markup stays
  literal.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass, incl. new file |

## Scope

**In scope**: `src/routes/email.ts`, `tests/email-page.spec.ts` (create).
**Out of scope**: the alert email rendering in `src/alerts/email.ts` (separate
module, separate plan area), and the email-address validation regex (that's a
different finding). Do not change route behavior or page markup/styling.

## Git workflow

- Branch: `advisor/005-email-escape-by-default`
- One commit: `Email: escape interpolated values by default in page()`.

## Steps

### Step 1: Add an auto-escaping `html` tagged template + a `SafeHtml` brand

In `src/routes/email.ts`, add a branded type and tagged template so the **only**
way to build a `body` is via interpolation-escaping:

```ts
// A string that is already HTML-safe (built via the `html` tagged template,
// which escapes every interpolation). page() accepts only this, so a raw
// unescaped string can't be passed by mistake.
type SafeHtml = string & { readonly __safeHtml: unique symbol };

function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += escapeHtml(String(values[i])) + (strings[i + 1] ?? '');
  }
  return out as SafeHtml;
}
```

Keep the existing `escapeHtml`.

### Step 2: Make `page` require `SafeHtml`

Change `page`'s signature so `body` is `SafeHtml` (still interpolated raw into
the template — but now it can only be produced by `html`, i.e. pre-escaped):

```ts
function page(title: string, body: SafeHtml, appUrl: string): string { /* unchanged body */ }
```

### Step 3: Convert the call sites to `html\`...\``

- Dynamic site (lines 20–26): `html\`Alerts are now active for <strong>${sub.email}</strong>. We'll email you when a new malicious clone of your repositories appears.\`` — note `${sub.email}` is now auto-escaped, so **remove the now-redundant `escapeHtml(...)` wrapper**.
- The three static sites: wrap each literal in `html\`...\`` (no interpolations,
  so trivially safe).

**Verify**: `pnpm typecheck` → exit 0 (the type now *forces* every `page` body
through `html`; a plain string is a type error).

### Step 4: Add tests

Create `tests/email-page.spec.ts`. Since `html`/`page` are module-private, either
(a) export `html` (and optionally `page`) from `email.ts` for testing, or (b)
test through a tiny exported wrapper. Prefer exporting `html` (it's a safe
utility). Cover:
- `html\`x ${'<script>alert(1)</script>'} y\`` contains `&lt;script&gt;` and not
  a literal `<script>`.
- `html\`<strong>${'a&b'}</strong>\`` keeps the literal `<strong>` but escapes
  `a&amp;b`.
- the rendered verify page (if `page` is exported) for an email like
  `"x\"><img src=x onerror=alert(1)>@e.com"` contains no unescaped `<img`.

**Verify**: `pnpm test -- email-page` → pass.

## Test plan

- `tests/email-page.spec.ts` (3 cases above). Pattern: `tests/mailProvider.spec.ts`.
- Verification: `pnpm test` all pass; `pnpm typecheck` exit 0.

## Done criteria

- [ ] `pnpm typecheck` exits 0 — `page` accepts only `SafeHtml`
- [ ] `grep -n "escapeHtml(sub.email)" src/routes/email.ts` returns no match (now auto-escaped)
- [ ] Every `page(...)` call's body is an `html\`...\`` template
- [ ] `pnpm test` exits 0 with the new escaping tests
- [ ] `git status` shows only `src/routes/email.ts` and `tests/email-page.spec.ts`
- [ ] `plans/README.md` row for 005 updated

## STOP conditions

- The rendered verify page changes visibly (the `<strong>` around the email must
  still render as bold) — if it shows literal `<strong>` tags, your `html`
  template escaped the static markup; fix the template (only interpolations
  escape).
- Making `page` take `SafeHtml` surfaces a caller you didn't expect (grep
  `page(` first) — convert it too, or STOP if it's outside `email.ts`.

## Maintenance notes

- New email pages must build their body with `html\`...\``; the type makes a raw
  string a compile error, which is the point.
- `src/alerts/email.ts` has its own `escapeHtml` and renders the alert emails
  (suspect repo names are attacker-controlled there too) — a follow-up could
  apply the same `html` helper there; out of scope here.
