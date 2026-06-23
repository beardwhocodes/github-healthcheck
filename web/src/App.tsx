import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from './api.js';
import type { Me, SelfReportResponse } from './api.js';
import { AccountReportView } from './components/AccountReportView.js';
import { AdminPanel } from './components/admin/AdminPanel.js';
import { AlertsPanel } from './components/AlertsPanel.js';
import { ClonesPanel } from './components/ClonesPanel.js';
import { ContactPanel } from './components/ContactPanel.js';
import { Footer } from './components/Footer.js';
import { Landing } from './components/Landing.js';
import { ScanAnyPanel } from './components/ScanAnyPanel.js';
import { SupportButton } from './components/SupportButton.js';
import { SuspendedNotice } from './components/SuspendedNotice.js';
import { clearCachedReport, readCachedReport, writeCachedReport } from './reportCache.js';
import { timeAgo } from './ui.js';

type Tab = 'self' | 'clones' | 'scan' | 'alerts' | 'contact' | 'admin';

function tabsFor(me: Me): { id: Tab; label: string }[] {
  const scanTabs: { id: Tab; label: string }[] = me.suspended
    ? []
    : [
        { id: 'self', label: 'My report' },
        { id: 'clones', label: 'Clone detection' },
        { id: 'scan', label: 'Scan any repo' },
        { id: 'alerts', label: 'Alerts' },
      ];
  return [
    ...scanTabs,
    { id: 'contact', label: 'Contact' },
    ...(me.isAdmin ? [{ id: 'admin' as Tab, label: '⚙ Admin' }] : []),
  ];
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading
  const [tab, setTab] = useState<Tab>('self');
  const [menuOpen, setMenuOpen] = useState(false); // mobile nav (hamburger) open state

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

  const tabs = tabsFor(me);
  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? 'contact');

  return (
    <>
      <header className="header">
        <Brand />
        <div className="header-right">
          <SupportButton />
          <UserChip me={me} onSignOut={() => setMe(null)} />
        </div>
      </header>
      <div className="container">
        <nav className="nav">
          {/* On mobile the tabs collapse behind this toggle; it shows the
              current section and is hidden on desktop (see styles.css). */}
          <button
            type="button"
            className="nav-toggle"
            aria-label="Sections menu"
            aria-expanded={menuOpen}
            aria-controls="nav-tabs"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="nav-toggle-icon" aria-hidden="true">☰</span>
            <span className="nav-toggle-label">
              {tabs.find((t) => t.id === activeTab)?.label ?? 'Menu'}
            </span>
          </button>
          <div
            id="nav-tabs"
            className={`tabs ${menuOpen ? 'open' : ''}`}
            role="tablist"
            aria-label="Report sections"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={activeTab === t.id}
                className={`tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => {
                  setTab(t.id);
                  setMenuOpen(false);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        {me.suspended && (
          <div style={{ marginBottom: 16 }}>
            <SuspendedNotice reason={me.suspendedReason} />
          </div>
        )}

        {activeTab === 'self' && <SelfReport login={me.login} />}
        {activeTab === 'clones' && <ClonesPanel />}
        {activeTab === 'scan' && <ScanAnyPanel />}
        {activeTab === 'alerts' && <AlertsPanel />}
        {activeTab === 'contact' && <ContactPanel />}
        {activeTab === 'admin' && <AdminPanel />}
      </div>
      <Footer />
    </>
  );
}

function Brand() {
  return (
    <div className="brand">
      <img className="logo" src="/logo.png" alt="" width={32} height={32} />
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
