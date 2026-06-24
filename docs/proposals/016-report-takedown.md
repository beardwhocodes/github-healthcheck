# Proposal 016: Report → Takedown Draft Action

**Status:** Spike / Design  
**Date:** 2026-06-24  
**Scope:** Admin-only; draft generation only — no auto-submission, no external calls.

---

## 1. Scope Boundary: Draft vs. Auto-Submit

**Recommendation: generate a human-reviewed draft; do not auto-submit.**

GitHub has no stable, public API for abuse reports. The support form at
`support.github.com/contact/report-abuse` is CAPTCHA-protected. The GitHub
staff team that processes these reports benefits from a human vouching for the
claim with their authenticated GitHub session — auto-submitted requests from a
server token would likely be ignored or rate-limited.

The liability argument is stronger: auto-submitting a report for a `confirmed`
record that later proves to be a false positive exposes the operator to DMCA
counter-notice risk and erodes reporter credibility with GitHub. A human
reviewing the prefilled text before hitting "Submit" is a 5-second gate that
eliminates that exposure.

The existing alert email (src/alerts/email.ts, `sendImpersonationAlert`) already
points users to `github.com/contact/report-abuse` with the expectation they
submit manually. The admin takedown draft follows the same philosophy at a
higher-fidelity level: pre-fill everything, let a human review and send.

**Note:** The existing frontend helper `buildReportUrl` (web/src/report.ts)
already constructs a prefilled support.github.com URL for the *end-user* flow.
The admin draft is the operator-side complement: a formatted text block the
admin (or impersonated-owner notifier) pastes into that same form, or into a
mailto: link.

---

## 2. Draft Contents: Field Mapping

A GitHub abuse report requires the following:

| GitHub form field | Source field | Notes |
|---|---|---|
| Reported repository (owner/name) | `suspectRepo` | Always present — required at record time |
| Content URL | `suspectUrl` | **Nullable — see gap below** |
| Category dropdown | `category` → `'malware'` or `'impersonation'` | Nullable — see gap below |
| Description / evidence | `confidence`, `adminNotes`, `reporterLogin`, `sourceRepo` | All optional fields; draft degrades gracefully |
| Reporter identity | Submitted by the human admin in their authenticated GitHub session | Not prefillable |

**Field gaps / prerequisites:**

- **`suspectUrl` is nullable.** The DB schema has `suspect_url TEXT NULL` and
  `ReportRecord.suspectUrl: string | null`. The column is populated only when
  the scanner engine has the GitHub URL at scan time. If `suspectUrl` is null,
  `buildTakedownDraft` must fall back to constructing
  `https://github.com/${suspectRepo}`. This is safe — `suspectRepo` is always
  `owner/name` format and always present. Document the fallback in the output
  and flag the case in adminNotes suggestion.

- **`category` is nullable.** Defaults to `'impersonation'` if absent (the
  safer/less-inflammatory choice when unsure). The admin can change it before
  submitting.

- **`sourceRepo` is nullable.** It drives the "I am the owner of X" framing.
  When null, the evidence paragraph falls back to omitting that line, and the
  admin can fill in manually.

- **`confidence` is nullable.** The draft omits the confidence line when null
  rather than fabricating a number.

- **`reporterLogin`** is always present. The draft cites it as "originally
  reported by GitHub user @{login}" to distinguish the original end-user
  reporter from the admin submitting.

---

## 3. Surface: Where the Template Lives

### Template function location

A new **pure function** `buildTakedownDraft(report: ReportRecord)` in
`src/reports/takedown.ts` returns `{ subject: string; body: string }`.

- **Pure / no I/O** — same pattern as `buildEvidenceText` in `web/src/report.ts`
  and the helpers in `src/alerts/email.ts`.
- Located in `src/reports/` next to `store.ts` to keep report-domain logic
  co-located.
- Exports no Env reference — callable in tests without a Worker context.

### Admin UI surface (AdminReports.tsx)

Add a **"Draft takedown"** button that appears only when `report.status ===
'confirmed'`. On click, it calls a new API endpoint
`POST /api/admin/reports/:id/takedown-draft` (or simply loads the draft
client-side if all data is already in the list row — preferred, as no extra
round-trip is needed).

**Preferred approach (client-side, no extra endpoint):**

All `AdminReport` fields are already present in the list response. The UI
can compute the draft inline using a client-side port of `buildTakedownDraft`
(or the same function imported via a shared module). Render the result in a
`<pre>` inside a modal/expandable panel with a "Copy to clipboard" button and
a `mailto:` link (see §4).

If a server endpoint is preferred for logging purposes (recording that a draft
was generated), add `POST /api/admin/reports/:id/takedown-draft` that:
1. Calls `getReport`, calls `buildTakedownDraft`, returns `{ subject, body }`.
2. Calls `audit(c, 'draft_takedown', report.suspectRepo, null)`.

### Copy-paste / export options

- **Copy to clipboard** (primary): `navigator.clipboard.writeText(draft.body)`.
- **mailto: link** (secondary): open `mailto:?subject=...&body=...` so the admin
  can email the impersonated owner directly (see §4).
- **GitHub form prefill link**: reuse the `buildReportUrl` pattern from
  `web/src/report.ts`, passing `suspectRepo` / `suspectUrl` / `category`.

---

## 4. Owner Notification (Optional Email to Impersonated Owner)

**Recommendation: out of first scope; design note only.**

The impersonated owner's email is not stored in `ReportRecord` — it would
require a GitHub API call (`GET /users/{owner}`) at draft time to look up a
public email (which is often blank). Requiring a live GitHub lookup couples the
draft to I/O and can fail or reveal PII (email address surfacing to admin).

The simpler path: generate a `mailto:` link in the draft with a prefilled
subject (`Re: Impersonation of your GitHub repo {sourceRepo}`) and a body block
drawn from `buildTakedownDraft`. The admin pastes their contact info and sends
it. This reuses `src/alerts/email.ts` patterns (text body composition) without
needing to plumb a recipient address.

If the product later builds "notify owner by email" as a feature, the
prerequisites are:
1. Store or look up the owner's verified email (outside this spike's scope).
2. Reuse `send()` from `src/alerts/email.ts` with a new
   `sendTakedownOwnerNotice` export.

---

## 5. Audit

When a draft is generated, record:
```
recordAudit(env, {
  adminLogin: actor.login,
  action: 'draft_takedown',
  target: report.suspectRepo,
  detail: report.id,
  now: Date.now(),
})
```

This requires adding `'draft_takedown'` to the `AuditAction` union in
`src/admin/audit.ts`. The category filter already handles unknown actions via
the `action <> 'login'` branch, so no migration is needed.

---

## 6. Open Questions for the Maintainer

1. **Client-side vs. server endpoint for draft generation?**  
   All required data is already in the AdminReports list response, so a
   client-side draft avoids a round-trip and an extra API surface. A server
   endpoint is only needed if the audit log entry for "draft generated" is
   required. Decide before implementing the UI.

2. **`suspect_url` reliability in practice?**  
   Query the `reported_repos` table for the fraction of rows where
   `suspect_url IS NULL`. If it is high, add a migration to backfill
   `'https://github.com/' || suspect_repo` for existing rows so the draft
   always has a clean URL.

3. **Owner notification email: in scope for V1 or follow-on?**  
   If in scope, the owner's email must come from somewhere. Options: (a) admin
   types it in a text field before sending, (b) a GitHub API call at draft
   time, (c) not supported (just a mailto: with blank To:). This is a product
   decision.

4. **`AuditAction` enum gating?**  
   The current `AuditAction` union is narrow (`update_report` etc.). Adding
   `'draft_takedown'` is a one-line change but requires a TypeScript redeploy.
   Confirm the audit addition is wanted before wiring.

5. **Should `takendown` status be auto-set when a draft is generated?**  
   Current flow: admin sets status = `confirmed`, then generates draft, then
   manually submits to GitHub, then sets status = `takendown`. An alternative:
   clicking "Draft takedown" auto-advances status to `takendown` and logs the
   draft action atomically. This collapses two clicks but prevents setting
   `takendown` without generating a draft. Decide on intended semantics.

6. **Multi-reporter aggregation in drafts?**  
   `suspectRepo` can have multiple `ReportRecord` rows from different reporters
   (de-duped by `(reporter_login, suspect_repo)`). The current admin endpoint
   exposes individual rows. Should the draft aggregate all reporters for the
   same `suspectRepo` into a single submission, or is one-per-row acceptable?
   The prototype below takes the simpler one-per-record approach.

---

## Prototype Note

The pure function `buildTakedownDraft` is implemented in
`src/reports/takedown.ts` and tested in `tests/takedown.spec.ts`. It:
- Accepts a `ReportRecord` (no I/O, no Env).
- Falls back gracefully for all nullable fields.
- Escapes no HTML (plain text output only — HTML escaping is the caller's
  responsibility if rendering into email shell).
- Returns `{ subject: string; body: string }` ready for clipboard / mailto.

See the implementation and tests for field interpolation details.
