import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from './api.js';
import type { Me, SelfReportResponse } from './api.js';
import { AccountReportView } from './components/AccountReportView.js';
import { AlertsPanel } from './components/AlertsPanel.js';
import { ClonesPanel } from './components/ClonesPanel.js';
import { Footer } from './components/Footer.js';
import { Landing } from './components/Landing.js';
import { ScanAnyPanel } from './components/ScanAnyPanel.js';
import { clearCachedReport, readCachedReport, writeCachedReport } from './reportCache.js';
import { timeAgo } from './ui.js';

type Tab = 'self' | 'clones' | 'scan' | 'alerts';

const TABS: { id: Tab; label: string }[] = [
  { id: 'self', label: 'My report' },
  { id: 'clones', label: 'Clone detection' },
  { id: 'scan', label: 'Scan any repo' },
  { id: 'alerts', label: 'Alerts' },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading
  const [tab, setTab] = useState<Tab>('self');

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div className="center-state">
        <span className="spinner" />
      </div>
    );
  }

  if (me === null) {
    return (
      <>
        <header className="header">
          <Brand />
        </header>
        <Landing />
        <Footer />
      </>
    );
  }

  return (
    <>
      <header className="header">
        <Brand />
        <UserChip me={me} onSignOut={() => setMe(null)} />
      </header>
      <div className="container">
        <div className="tabs" role="tablist" aria-label="Report sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'self' && <SelfReport login={me.login} />}
        {tab === 'clones' && <ClonesPanel />}
        {tab === 'scan' && <ScanAnyPanel />}
        {tab === 'alerts' && <AlertsPanel />}
      </div>
      <Footer />
    </>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="logo">🛡️</span>
      <div>
        GitHub Healthcheck
        <small>GitHub malware &amp; clone scanner</small>
      </div>
    </div>
  );
}

function UserChip({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  async function signOut() {
    clearCachedReport();
    await api.logout().catch(() => {});
    onSignOut();
  }
  return (
    <div className="user-chip">
      <img src={me.avatarUrl} alt="" />
      <span className="small muted">{me.login}</span>
      <button className="btn ghost small" style={{ padding: '6px 12px' }} onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}

function SelfReport({ login }: { login: string }) {
  const [data, setData] = useState<SelfReportResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.selfReport();
      setData(d);
      setFetchedAt(writeCachedReport(login, d));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scan failed.');
    } finally {
      setLoading(false);
    }
  }, [login]);

  // On mount: show the cached report instantly if present; only scan when the
  // cache is missing or stale (older than the TTL). Tab switches and reloads
  // therefore reuse the last result instead of rescanning every time.
  useEffect(() => {
    const cached = readCachedReport(login);
    if (cached) {
      setData(cached.data);
      setFetchedAt(cached.fetchedAt);
      if (cached.stale) void runScan();
    } else {
      void runScan();
    }
  }, [login, runScan]);

  if (loading && !data) {
    return (
      <div className="center-state">
        <span className="spinner" /> Scanning your account and repositories…
        <div className="faint small mt8">Pulling READMEs, commits, releases and contributors.</div>
      </div>
    );
  }
  if (error && !data) {
    return <div className="banner error">{error}</div>;
  }
  if (!data) return null;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <span className="muted small">
          {loading ? 'Rescanning…' : `Scanned ${timeAgo(fetchedAt ? new Date(fetchedAt).toISOString() : null)}`}
          <span className="faint"> · cached for 30 min</span>
        </span>
        <button
          className="btn ghost small"
          style={{ padding: '6px 12px' }}
          onClick={() => void runScan()}
          disabled={loading}
        >
          {loading ? <span className="spinner" /> : '↻ Rescan'}
        </button>
      </div>
      {error && <div className="banner error" style={{ marginBottom: 12 }}>{error}</div>}
      <AccountReportView report={data.report} scanned={data.scanned} totalRepos={data.totalRepos} />
    </div>
  );
}
