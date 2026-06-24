// Builds a copy-paste-ready GitHub abuse report draft from a confirmed
// ReportRecord. Pure function — no I/O, no Env reference, no external calls.
// The caller is responsible for HTML-escaping if embedding in email HTML;
// the output here is plain text for clipboard / mailto use.
import type { ReportRecord } from './store.js';
import type { AbuseCategory } from '../admin/constants.js';

export interface TakedownDraft {
  subject: string;
  body: string;
}

// GitHub's support form base URL — MUST be support.github.com, not the
// github.com redirect which strips query params (verified 2026-06-19).
const REPORT_ABUSE_BASE = 'https://support.github.com/contact/report-abuse';

// Taxonomy IDs for the hidden report_type field in the GitHub support form.
const REPORT_TYPE_ID: Record<AbuseCategory, string> = {
  malware: 'cat_ts_malware',
  impersonation: 'cat_ts_impersonation',
};

// Resolve the effective abuse category: use stored category if present,
// default to 'impersonation' (the safer choice when unsure).
function resolveCategory(category: AbuseCategory | null): AbuseCategory {
  return category ?? 'impersonation';
}

// Derive a best-effort public URL for the suspect repo. suspectUrl is nullable
// in the DB; fall back to the canonical GitHub path derived from suspectRepo
// (which is always present in owner/name format).
function resolveSuspectUrl(report: ReportRecord): string {
  if (report.suspectUrl) return report.suspectUrl;
  return `https://github.com/${report.suspectRepo}`;
}

// Build a prefilled GitHub abuse report URL. The human still has to click
// through the CAPTCHA-protected form — we never auto-submit.
function buildReportUrl(report: ReportRecord): string {
  const category = resolveCategory(report.category);
  const suspectUrl = resolveSuspectUrl(report);
  const params = new URLSearchParams({
    category: 'report-abuse',
    report: report.suspectRepo,
    report_type: REPORT_TYPE_ID[category],
    report_content_url: suspectUrl,
  });
  return `${REPORT_ABUSE_BASE}?${params.toString()}`;
}

// Return a human-readable label for the category for use in the subject line.
function categoryLabel(category: AbuseCategory): string {
  return category === 'malware' ? 'malware/exploits' : 'impersonation';
}

// Compose the plain-text body of the draft. All nullable fields degrade
// gracefully — callers should review before submitting.
function buildBody(report: ReportRecord): string {
  const category = resolveCategory(report.category);
  const suspectUrl = resolveSuspectUrl(report);
  const urlNote = report.suspectUrl
    ? ''
    : '\n[NOTE: suspect URL was not recorded — verify this URL before submitting.]';

  const sourceBlock = report.sourceRepo
    ? [
        `The repository below appears to be a malicious clone of:`,
        `  https://github.com/${report.sourceRepo}`,
        '',
      ].join('\n')
    : `The repository below has been flagged for ${categoryLabel(category)}.\n`;

  const confidenceBlock =
    report.confidence != null
      ? `Automated detection confidence: ${report.confidence}/100\n`
      : '';

  const notesBlock = report.adminNotes
    ? `Admin notes: ${report.adminNotes}\n`
    : '';

  const lines = [
    `Suspect repository: ${report.suspectRepo}`,
    `URL: ${suspectUrl}${urlNote}`,
    `Category: ${categoryLabel(category)}`,
    '',
    sourceBlock,
    confidenceBlock,
    `Originally reported by GitHub user @${report.reporterLogin} via GitHub Healthcheck.`,
    '',
    notesBlock,
    'This report was prepared using GitHub Healthcheck automated detection.',
    'Please review the repository for removal under GitHub Acceptable Use Policies.',
    '',
    `Prefilled form link (open in browser, review, and submit):`,
    buildReportUrl(report),
  ].join('\n');

  return lines;
}

// Build a takedown draft from a confirmed ReportRecord.
// Returns { subject, body } — both plain text, safe for clipboard or mailto.
// Does NOT send anything or call any external service.
export function buildTakedownDraft(report: ReportRecord): TakedownDraft {
  const category = resolveCategory(report.category);
  const subject = `Abuse report: ${categoryLabel(category)} — ${report.suspectRepo}`;
  const body = buildBody(report);
  return { subject, body };
}
