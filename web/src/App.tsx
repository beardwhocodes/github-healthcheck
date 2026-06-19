import { useEffect, useState } from 'react';

import { ApiError, api } from './api.js';
import type { Me, SelfReportResponse } from './api.js';
import { AccountReportView } from './components/AccountReportView.js';
import { AlertsPanel } from './components/AlertsPanel.js';
import { ClonesPanel } from './components/ClonesPanel.js';
import { Landing } from './components/Landing.js';
import { ScanAnyPanel } from './components/ScanAnyPanel.js';

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
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'self' && <SelfReport />}
        {tab === 'clones' && <ClonesPanel />}
        {tab === 'scan' && <ScanAnyPanel />}
        {tab === 'alerts' && <AlertsPanel />}
      </div>
    </>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="logo">🛡️</span>
      <div>
        RepoSentry
        <small>GitHub malware &amp; clone scanner</small>
      </div>
    </div>
  );
}

function UserChip({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  async function signOut() {
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

function SelfReport() {
  const [data, setData] = useState<SelfReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .selfReport()
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Scan failed.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="center-state">
        <span className="spinner" /> Scanning your account and repositories…
        <div className="faint small mt8">Pulling READMEs, commits, releases and contributors.</div>
      </div>
    );
  }
  if (error) {
    return <div className="banner error">{error}</div>;
  }
  if (!data) return null;

  return <AccountReportView report={data.report} scanned={data.scanned} totalRepos={data.totalRepos} />;
}
