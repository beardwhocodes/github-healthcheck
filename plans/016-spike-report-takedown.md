# Plan 016 [SPIKE]: Design the report→takedown action (close the triage→action gap)

> **Executor instructions**: DESIGN/INVESTIGATION spike. Deliverable is a design
> doc + (optionally) a thin prototype of the draft generator. Do NOT build
> automated abuse submission. Update plan 016's row in `plans/README.md`.

## Status

- **Priority**: P3
- **Effort**: M (design/spike; coarse)
- **Risk**: MED (automated abuse submissions carry false-positive liability — a "draft for human review" scope is the safe boundary)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters (product value)

The product detects and triages impersonation but **stops at the moment of
value**: users report suspect repos, admins flip status through
`reported`→`reviewing`→`confirmed`→`takendown`, but **no code drafts a GitHub
abuse report or notifies the impersonated owner** — "takedown" is just a status
flip. The alert email even tells users to manually "Report confirmed
impersonations at github.com/contact/report-abuse" (`src/alerts/email.ts:96`).
The data model already holds everything a pre-filled abuse report needs. This
spike designs an admin action that turns a `confirmed` report into a
copy-paste-ready (or sent) takedown — the friction the project visibly offloads
to users today.

## Current state (grounding)

- `src/reports/store.ts` — `ReportRecord` carries `reporterLogin`, `suspectRepo`,
  `suspectUrl`, `sourceRepo`, `confidence`, `category` (`'malware' |
  'impersonation'`), `status`, `adminNotes`, timestamps. `updateReport` already
  edits status/notes; `getReport(id)` fetches one.
- `src/routes/admin.ts` exposes the report list/update endpoints; the admin SPA
  view is `web/src/components/admin/AdminReports.tsx`.
- `src/admin/constants.ts` — `ReportStatus` includes `confirmed` and `takendown`.
- Email rendering lives in `src/alerts/email.ts` (HTML+text, `escapeHtml`), the
  pattern to reuse for any owner-notification draft.

## Deliverable

A design doc at `docs/proposals/016-report-takedown.md` (create `docs/proposals/`
if needed) covering the decisions below + this plan's row updated.

## Investigate & decide (write into the doc)

1. **Scope boundary**: confirm "generate a draft for a human to submit" (low
   liability) vs "auto-submit to GitHub" (high liability + GitHub's abuse API is
   access-gated). Recommend the draft path; state why.
2. **Draft contents**: what a GitHub abuse report needs (suspect repo URL, the
   original repo it impersonates, category, evidence/confidence, reporter). Map
   each to a `ReportRecord` field; note any gap (e.g. is `suspect_url` always
   present?).
3. **Surface**: an admin-only action on a `confirmed` report in
   `AdminReports.tsx` that renders the filled template (copy-paste) — plus
   optionally a `mailto:`/structured export. Where does the template text live
   (a new pure function, unit-testable like the engine)?
4. **Owner notification (optional)**: drafting an email to the impersonated repo
   owner (reuse `alerts/email.ts` rendering). Decide in/out of first scope.
5. **Audit**: a takedown-draft action should write to `admin_audit`
   (`recordAudit`, action e.g. `draft_takedown`). Note it.
6. **Open questions** for the maintainer.

## Optional thin prototype (de-risk)

If useful, prototype the **pure draft generator** only: a function
`buildTakedownDraft(report: ReportRecord): { subject: string; body: string }` in
a new `src/reports/takedown.ts`, with a unit test (`tests/takedown.spec.ts`,
pattern `tests/report.spec.ts`) asserting the fields are interpolated and escaped.
This is safe (pure, no I/O, no submission) and proves the data is sufficient. Do
NOT wire a submit button or external call.

## Done criteria

- [ ] `docs/proposals/016-report-takedown.md` answers items 1–6 with a recommendation
- [ ] It maps every needed abuse-report field to a `ReportRecord` field (and flags gaps)
- [ ] If prototyped: `buildTakedownDraft` + its unit test exist and pass (`pnpm test`),
      with NO submission/external call wired
- [ ] `plans/README.md` row for 016 updated

## STOP conditions

- You're about to call a GitHub abuse/report endpoint or auto-send an email —
  STOP; first-scope is draft-for-human-review only.
- A required field (e.g. a canonical suspect URL) isn't reliably in the data —
  document it as a prerequisite, don't fabricate it.

## Maintenance notes

- Keep the draft generator pure and unit-tested (like `src/engine`) so the
  template is reviewable and stable.
- If owner-notification is added later, it sends mail to an address derived from
  GitHub data — treat that recipient like any user-influenced email (validation,
  rate limit) and reuse the escaping helper.
