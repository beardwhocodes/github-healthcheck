import { useState } from 'react';

import { ApiError, api } from '../api.js';
import type { ScanResponse } from '../api.js';
import { AccountReportView } from './AccountReportView.js';
import { RepoReportCard } from './RepoReportCard.js';

export function ScanAnyPanel() {
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const value = target.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.scan(value));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scan failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h3 className="section-title">Vet any repo or account</h3>
        <p className="muted small" style={{ margin: '4px 0 12px', maxWidth: 620 }}>
          Found a repo via search or had an AI agent suggest one? Check it before you clone or run
          anything. Paste a GitHub URL, <code>owner/repo</code>, or a username.
        </p>
        <div className="input-row">
          <input
            type="text"
            placeholder="e.g. github.com/owner/repo  or  owner/repo  or  username"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            aria-label="GitHub repo or account to scan"
          />
          <button className="btn" onClick={run} disabled={loading || !target.trim()}>
            {loading ? <span className="spinner" /> : 'Scan'}
          </button>
        </div>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {loading && (
        <div className="center-state">
          <span className="spinner" /> Scanning…
        </div>
      )}

      {result && !loading && (
        <div className="mt16">
          {result.kind === 'repo' ? (
            <RepoReportCard report={result.report} defaultOpen />
          ) : (
            <AccountReportView
              report={result.report}
              scanned={result.scanned}
              totalRepos={result.totalRepos}
            />
          )}
        </div>
      )}
    </div>
  );
}
