# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue, PR, or
discussion for anything security-sensitive.

- **Preferred:** open a private report via GitHub Security Advisories
  ([Security tab → "Report a vulnerability"](../../security/advisories/new)).
  This keeps the discussion private until a fix is available.
- **Email (fallback):** security@example.com  <!-- MAINTAINER: set a real address before launch -->

Please include enough to reproduce: affected version/commit, impact, and a
proof-of-concept or steps where possible.

## Supported versions

This project ships from `master` to a single hosted deployment; there are no
maintained release branches. Security fixes land on `master` and are deployed
from there. Always test against the latest `master`.

| Version  | Supported |
| -------- | --------- |
| `master` (latest) | yes |
| older commits / forks | no |

## Response expectations

These are good-faith targets for a small, best-effort project, not a contractual
SLA:

- **Acknowledgement:** within 3 business days.
- **Initial assessment** (severity + whether it's in scope): within 7 business days.
- **Fix or mitigation plan:** prioritized by severity once confirmed.

We'll keep you updated through the advisory and credit you in the disclosure
unless you prefer to remain anonymous. Please allow reasonable time for a fix
before any public disclosure (coordinated disclosure).

## Your data & account deletion

Signing in stores your GitHub OAuth token **encrypted at rest** (AES-GCM, key
derived from a server secret); session ids are stored hashed. You can erase
everything at any time:

- **In the app:** the **Alerts** tab → **Delete account** permanently removes
  your account.
- **API:** `DELETE /api/me` (authenticated).

Deletion revokes this app's GitHub OAuth grant, then deletes all stored rows
(sessions, alert subscriptions, watched repos/known clones, scan history,
support messages, and reports). Turning off alerts (or using an alert email's
unsubscribe link) additionally zeroes the stored OAuth token for that
subscription.
