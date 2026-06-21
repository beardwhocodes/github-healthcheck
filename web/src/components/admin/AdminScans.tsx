import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { ScanAuditItem } from '../../api.js';
import { fmtDate, timeAgo } from '../../ui.js';

const KIND_LABEL: Record<string, string> = {
  self: 'Self-audit',
  repo: 'Repo',
  account: 'Account',
  clones: 'Clone scan',
};

const KIND_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All scans' },
  { value: 'self', label: 'Self-audits' },
  { value: 'repo', label: 'Repo scans' },
  { value: 'account', label: 'Account scans' },
  { value: 'clones', label: 'Clone scans' },
];

// Audit of every repo/account scanned, across all users. The `scans` table
// already records each run; this surfaces it as a reviewable, filterable feed.
export function AdminScans() {
  const [scans, setScans] = useState<ScanAuditItem[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);

  function load(kind: string) {
    setScans(null);
    setError(null);
    api.admin
      .scans(kind)
      .then((res) => setScans(res.scans))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the scan log.'));
  }

  useEffect(() => {
    load(filter);
  }, [filter]);

  return (
    <div>
      <div className="toolbar">
        <label className="field-label" htmlFor="scan-kind-filter">
          Type
        </label>
        <select
          id="scan-kind-filter"
          className="select-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {KIND_FILTERS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={() => load(filter)}>
          Refresh
        </button>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {scans === null ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : scans.length === 0 ? (
        <p className="faint small mt16">No scans recorded yet.</p>
      ) : (
        <table className="data-table mt16">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Type</th>
              <th>Target</th>
              <th>Top risk</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((s, i) => {
              const iso = new Date(s.createdAt).toISOString();
              return (
                <tr key={`${s.login}-${s.createdAt}-${i}`}>
                  <td className="muted small" title={fmtDate(iso)}>
                    {timeAgo(iso)}
                  </td>
                  <td>{s.login}</td>
                  <td>
                    <span className="pill">{KIND_LABEL[s.kind] ?? s.kind}</span>
                  </td>
                  <td>
                    {s.target ? (
                      <span className="chip">{s.target}</span>
                    ) : (
                      <span className="faint small">own repositories</span>
                    )}
                  </td>
                  <td>
                    <RiskCell score={s.topScore} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RiskCell({ score }: { score: number | null }) {
  if (score == null) return <span className="faint small">—</span>;
  const cls =
    score >= 70 ? 'pill danger' : score >= 45 ? 'pill warn' : score >= 25 ? 'pill' : 'muted small';
  return <span className={cls}>{score}</span>;
}
