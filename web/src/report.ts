// Helpers for reporting a suspected malicious clone to GitHub.
//
// GitHub has NO API to file abuse reports — it is a CAPTCHA-protected web form.
// So we only ever PREFILL and open the form in a new tab; the human reviews,
// picks the (non-prefillable) category, pastes the evidence, and submits. We
// never auto-submit.
import type { CloneMatch } from '../../src/engine/types.js';

export type AbuseCategory = 'malware' | 'impersonation';

// The label the user must pick in GitHub's required "Select a category" dropdown
// (the form does NOT let us prefill the visible dropdown — only a hidden id).
export const ABUSE_CATEGORY_LABEL: Record<AbuseCategory, string> = {
  malware: 'Active Malware or Exploits',
  impersonation: 'Impersonation',
};

// GitHub taxonomy ids for the hidden contact[report_type] field.
// VERIFIED 2026-06-19 against the live form — re-check if GitHub changes it.
const REPORT_TYPE_ID: Record<AbuseCategory, string> = {
  malware: 'cat_ts_malware',
  impersonation: 'cat_ts_impersonation',
};

// MUST be support.github.com — the github.com/contact/report-abuse redirect
// strips report_type and report_content_url.
export const REPORT_ABUSE_BASE = 'https://support.github.com/contact/report-abuse';
export const REPORT_ABUSE_FALLBACK_URL = REPORT_ABUSE_BASE;

// Default to "malware" when the copy carries real payload/malware indicators;
// otherwise treat it as plain identity impersonation.
export function pickAbuseCategory(match: CloneMatch): AbuseCategory {
  const band = match.report.band;
  if (band === 'high' || band === 'critical') return 'malware';
  const hasStrongFinding = match.report.findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
  return hasStrongFinding ? 'malware' : 'impersonation';
}

export function buildReportUrl(match: CloneMatch, category?: AbuseCategory): string {
  const cat = category ?? pickAbuseCategory(match);
  const params = new URLSearchParams({
    category: 'report-abuse',
    report: match.suspectRepo, // owner/name
    report_type: REPORT_TYPE_ID[cat],
    report_content_url: match.suspectUrl, // full github.com URL
  });
  return `${REPORT_ABUSE_BASE}?${params.toString()}`;
}

// A factual, hedged evidence block the user pastes into the form's required
// description. Deliberately says "appears to be" + cites automated confidence so
// users don't file overconfident false reports.
export function buildEvidenceText(match: CloneMatch): string {
  const reasons = match.matchReasons.length > 0
    ? match.matchReasons.map((r) => `- ${r}`).join('\n')
    : '- Same repository name published under a different account';

  const indicators = match.report.findings.length > 0
    ? match.report.findings
        .map((f) => {
          const evidence = f.evidence && f.evidence.length > 0 ? `\n  Evidence: ${f.evidence.join(', ')}` : '';
          return `- [${f.severity}] ${f.title}: ${f.detail}${evidence}`;
        })
        .join('\n')
    : '- (No payload indicators detected on the copy; flagged on structural/impersonation grounds.)';

  return [
    `I'm the owner of ${match.sourceRepo} (https://github.com/${match.sourceRepo}). The repository`,
    'below appears to be a malicious clone impersonating my project and should be reviewed for removal.',
    '',
    `Reported repository: ${match.suspectUrl}`,
    `Owner: ${match.suspectOwner}`,
    `Appears to copy: https://github.com/${match.sourceRepo}`,
    '',
    `Why this looks like malicious impersonation (automated detection, confidence ${match.confidence}/100):`,
    reasons,
    '',
    'Detected malware / abuse indicators:',
    indicators,
    '',
    'This matches the known pattern of cloning a legitimate repository and adding a poisoned README or',
    'release that directs victims to download malware. Please review under GitHub\'s Acceptable Use',
    'Policies (malware/exploits).',
    '',
    'Reported via GitHub Healthcheck.',
  ].join('\n');
}
