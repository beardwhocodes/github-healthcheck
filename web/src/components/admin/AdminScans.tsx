import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { ScanAuditItem, TopScannedItem } from '../../api.js';
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

type Mode = 'recent' | 'top';

// Audit of what's been scanned, across all users. Two views: a chronological
// "Recent" feed (every scan run) and "Most scanned" (distinct targets ranked by
// how many times they've been scanned). Both read the existing `scans` table.
export function AdminScans() {
  const [mode, setMode] = useState<Mode>('recent');

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={`btn small ${mode === 'recent' ? '' : 'ghost'}`}
          onClick={() => setMode('recent')}
        >
          Recent activity
        </button>
        <button
          type="button"
          className={`btn small ${mode === 'top' ? '' : 'ghost'}`}
          onClick={() => setMode('top')}
        >
          Most scanned
        </button>
      </div>

      {mode === 'recent' ? <RecentFeed /> : <MostScanned />}
    </div>
  );
}

function RecentFeed() {
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

function MostScanned() {
  const [targets, setTargets] = useState<TopScannedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setTargets(null);
    setError(null);
    api.admin
      .topScans()
      .then((res) => setTargets(res.targets))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load most-scanned.'));
  }

  useEffect(load, []);

  return (
    <div>
      <div className="toolbar">
        <p className="muted small" style={{ margin: 0 }}>
          Distinct repositories and accounts, ranked by how often they&apos;ve been scanned.
          Self-audits and clone scans (which cover a user&apos;s own repos) aren&apos;t counted here.
        </p>
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={load}>
          Refresh
        </button>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {targets === null ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : targets.length === 0 ? (
        <p className="faint small mt16">No repos or accounts have been scanned yet.</p>
      ) : (
        <table className="data-table mt16">
          <thead>
            <tr>
              <th>Target</th>
              <th>Type</th>
              <th>Scans</th>
              <th>Distinct users</th>
              <th>Last scanned</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => {
              const iso = new Date(t.lastScanned).toISOString();
              return (
                <tr key={t.target}>
                  <td>
                    <span className="chip">{t.target}</span>
                  </td>
                  <td>
                    <span className="pill">{KIND_LABEL[t.kind] ?? t.kind}</span>
                  </td>
                  <td>
                    <b>{t.scans.toLocaleString()}</b>
                  </td>
                  <td>{t.scanners.toLocaleString()}</td>
                  <td className="muted small" title={fmtDate(iso)}>
                    {timeAgo(iso)}
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
