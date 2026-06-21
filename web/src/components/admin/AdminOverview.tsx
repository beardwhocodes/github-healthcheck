import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { AdminStats } from '../../api.js';

export function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .admin.stats()
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load stats.'));
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!stats) return <div className="center-state"><span className="spinner" /></div>;

  return (
    <div>
      <div className="admin-grid">
        <Stat num={stats.users.total} label="Total users" sub={`${stats.users.active7d} active this week`} />
        <Stat num={stats.users.newToday} label="New today" sub={`${stats.users.new7d} this week`} />
        <Stat num={stats.scans.total} label="Total scans" sub={`${stats.scans.last24h} in last 24h`} />
        <Stat
          num={stats.users.suspended}
          label="Suspended"
          sub={`${stats.users.admins} admin${stats.users.admins === 1 ? '' : 's'}`}
        />
        <Stat num={stats.messages.open} label="Open messages" sub={`${stats.messages.total} all time`} />
        <Stat num={stats.reports.total} label="Reported repos" sub={`${stats.reports.byStatus.reviewing ?? 0} in review`} />
      </div>

      <div className="card mt24">
        <h3 className="section-title" style={{ marginBottom: 4 }}>
          Scans per day
        </h3>
        <p className="faint small" style={{ marginTop: 0 }}>
          Last 14 days · {stats.scans.last7d} in the past week · your local time ({localTzLabel()})
        </p>
        <ScanBarChart data={stats.scans.perDay} />
      </div>

      <div className="admin-grid mt24" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <h3 className="section-title" style={{ marginBottom: 10 }}>
            Scans by type
          </h3>
          {Object.keys(stats.scans.byKind).length === 0 ? (
            <p className="faint small">No scans yet.</p>
          ) : (
            (['self', 'repo', 'account', 'clones'] as const).map((k) => (
              <div className="stat-row" key={k}>
                <span className="muted">{KIND_LABEL[k]}</span>
                <b>{stats.scans.byKind[k] ?? 0}</b>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h3 className="section-title" style={{ marginBottom: 10 }}>
            Most-reported repos
          </h3>
          {stats.reports.topReported.length === 0 ? (
            <p className="faint small">No reports yet.</p>
          ) : (
            stats.reports.topReported.map((r) => (
              <div className="stat-row" key={r.suspectRepo}>
                <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.suspectRepo}
                </span>
                <b>
                  {r.reporters} report{r.reporters === 1 ? '' : 's'}
                </b>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  self: 'Self-audit',
  repo: 'Scan a repo',
  account: 'Scan an account',
  clones: 'Clone detection',
};

// A short label for the viewer's timezone, e.g. "EDT" or "UTC−5".
function localTzLabel(): string {
  try {
    const named = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    if (named) return named;
  } catch {
    /* fall through to the numeric offset */
  }
  const off = -new Date().getTimezoneOffset() / 60;
  return `UTC${off >= 0 ? '+' : '−'}${Math.abs(off)}`;
}

function Stat({ num, label, sub }: { num: number; label: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-num">{num.toLocaleString()}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ScanBarChart({ data }: { data: { day: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bar-chart">
      {data.map((d) => (
        <div className="bar" key={d.day} title={`${d.day}: ${d.count}`}>
          <div className="bar-fill" style={{ height: `${(d.count / max) * 100}%` }} />
          <div className="bar-label">{d.day.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}
