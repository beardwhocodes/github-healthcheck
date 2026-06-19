import { useState } from 'react';

import { ApiError, api } from '../api.js';
import type { ClonesResponse, CloneMatch } from '../api.js';
import {
  ABUSE_CATEGORY_LABEL,
  REPORT_ABUSE_FALLBACK_URL,
  buildEvidenceText,
  buildReportUrl,
  pickAbuseCategory,
} from '../report.js';
import { fmtDate } from '../ui.js';
import { BandBadge, FindingItem } from './Primitives.js';

export function ClonesPanel() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ClonesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setData(await api.clones());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scan failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="row-between">
          <div>
            <h3 className="section-title">Clone &amp; impersonation detection</h3>
            <p className="muted small" style={{ margin: '4px 0 0', maxWidth: 620 }}>
              We search GitHub for other repositories sharing your repo names, then score each copy
              for the malware-distribution pattern. This is exactly how the campaign weaponizes your
              work — a verbatim clone of your code with a single poisoned README.
            </p>
          </div>
          <button className="btn" onClick={run} disabled={loading}>
            {loading ? <span className="spinner" /> : '🔍'} Scan for clones
          </button>
        </div>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {loading && (
        <div className="center-state">
          <span className="spinner" /> Searching GitHub for copies of your repositories…
          <div className="faint small mt8">This checks several of your most-starred repos.</div>
        </div>
      )}

      {data && !loading && (
        <div className="mt16">
          <p className="muted small">
            Scanned {data.sourcesScanned} of your repositories.{' '}
            {data.matches.length === 0 ? (
              <span style={{ color: 'var(--safe)' }}>No suspicious clones found. ✅</span>
            ) : (
              <span style={{ color: 'var(--high)' }}>
                {data.matches.length} suspicious cop{data.matches.length === 1 ? 'y' : 'ies'} found.
              </span>
            )}
          </p>
          {data.matches.map((m) => (
            <CloneMatchCard match={m} key={m.suspectRepo} />
          ))}
        </div>
      )}
    </div>
  );
}

function CloneMatchCard({ match }: { match: CloneMatch }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const category = pickAbuseCategory(match);
  const reportUrl = buildReportUrl(match, category);

  // GitHub's form can't pre-fill the description, so copy the evidence to the
  // clipboard the moment the user clicks Report — ready to paste.
  async function copyEvidence() {
    try {
      await navigator.clipboard.writeText(buildEvidenceText(match));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard can be blocked (permissions / insecure context) — the user
      // can still open the form and the fallback link is shown.
      setCopied(false);
    }
  }

  return (
    <div className="card mt16">
      <div className="match" style={{ paddingTop: 0 }}>
        <div className="row1">
          <a href={match.suspectUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 700 }}>
            {match.suspectRepo}
          </a>
          <BandBadge band={match.report.band} />
          <span className="confidence">
            confidence <b>{match.confidence}</b>/100
          </span>
        </div>
        <div className="muted small">
          appears to copy <b>{match.sourceRepo}</b> · {match.suspectStars}★ · created{' '}
          {fmtDate(match.suspectCreatedAt)}
        </div>
        {match.matchReasons.length > 0 && (
          <div className="reasons">Why flagged: {match.matchReasons.join('; ')}.</div>
        )}

        <div className="match-actions">
          <a
            className="btn small"
            href={reportUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={copyEvidence}
            style={{ padding: '6px 12px' }}
          >
            ⚠ Report to GitHub
          </a>
          <button
            className="btn ghost small"
            onClick={copyEvidence}
            style={{ padding: '6px 12px' }}
          >
            {copied ? '✓ Copied evidence' : '📋 Copy evidence'}
          </button>
          <button className="btn ghost small" onClick={() => setOpen((v) => !v)} style={{ padding: '6px 12px' }}>
            {open ? 'Hide' : 'Show'} {match.report.findings.length} finding
            {match.report.findings.length === 1 ? '' : 's'}
          </button>
        </div>
        <div className="faint small mt8">
          GitHub can&apos;t pre-fill the category or description — choose{' '}
          <b>{ABUSE_CATEGORY_LABEL[category]}</b> in the dropdown and paste the copied evidence
          (it&apos;s copied automatically when you click Report).
        </div>

        {open && (
          <div className="mt8">
            {match.report.findings.map((f) => (
              <FindingItem finding={f} key={f.id} />
            ))}
            <p className="faint small mt8">
              Fallback if the link doesn&apos;t pre-fill:{' '}
              <a href={REPORT_ABUSE_FALLBACK_URL} target="_blank" rel="noreferrer noopener">
                support.github.com/contact/report-abuse ↗
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
