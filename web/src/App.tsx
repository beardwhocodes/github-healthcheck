import { Suspense, lazy, useCallback, useEffect, useState } from 'react';

import { ApiError, api } from './api.js';
import type { Me, SelfReportResponse } from './api.js';
import { setAuthed, wasAuthed } from './authHint.js';
import { AccountReportView } from './components/AccountReportView.js';
const AdminPanel = lazy(() =>
  import('./components/admin/AdminPanel.js').then((m) => ({ default: m.AdminPanel })),
);
import { AlertsPanel } from './components/AlertsPanel.js';
import { Brand } from './components/Brand.js';
import { ClonesPanel } from './components/ClonesPanel.js';
import { ContactPanel } from './components/ContactPanel.js';
import { Footer } from './components/Footer.js';
import { ScanAnyPanel } from './components/ScanAnyPanel.js';
import { SignedOut } from './components/SignedOut.js';
import { SupportButton } from './components/SupportButton.js';
import { SuspendedNotice } from './components/SuspendedNotice.js';
import { TAB_PATH, TAB_TITLE, pathToTab, tabsFor } from './nav.js';
import type { Tab } from './nav.js';
import { clearCachedReport, readCachedReport, writeCachedReport } from './reportCache.js';
import { timeAgo } from './ui.js';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setAuthed(true);
      })
      .catch(() => {
        setMe(null);
        setAuthed(false);
      });
  }, []);

  async function handleSignOut() {
    clearCachedReport();
    setAuthed(false);
    await api.logout().catch(() => {});
    setMe(null);
  }

  // While the session check is in flight: returning users (per the local hint)
  // see a spinner; everyone else sees the prerendered landing — the same markup
  // crawlers and no-JS visitors get, so there's no flash for new visitors.
  if (me === undefined) {
    return wasAuthed() ? (
      <div className="center-state">
        <span className="spinner" />
      </div>
    ) : (
      <SignedOut />
    );
  }

  if (me === null) {
    return <SignedOut />;
  }

  return <SignedInApp me={me} onSignOut={handleSignOut} />;
}

function SignedInApp({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [path, setPath] = useState(() => window.location.pathname);
  const [menuOpen, setMenuOpen] = useState(false); // mobile nav (hamburger)

  // Reflect browser back/forward into the active section.
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const tabs = tabsFor(me);
  const requested = pathToTab(path);
  const activeTab: Tab = tabs.some((t) => t.id === requested)
    ? requested
    : (tabs[0]?.id ?? 'contact');

  // Keep the URL and document title aligned with the resolved section. If the
  // path named a section this user can't see, normalize it in place (no new
  // history entry).
  useEffect(() => {
    const wanted = TAB_PATH[activeTab];
    if (window.location.pathname !== wanted) {
      window.history.replaceState(null, '', wanted);
      setPath(wanted);
    }
    document.title = `${TAB_TITLE[activeTab]} · GitHub Healthcheck`;
  }, [activeTab]);

  function navigate(next: Tab) {
    const to = TAB_PATH[next];
    if (window.location.pathname !== to) {
      window.history.pushState(null, '', to);
    }
    setPath(to);
    setMenuOpen(false);
  }

  return (
    <>
      <header className="header">
        <Brand />
        <div className="header-right">
          <SupportButton />
          <UserChip me={me} onSignOut={onSignOut} />
        </div>
      </header>
      <div className="container">
        <nav className="nav">
          {/* On mobile the tabs and account actions collapse behind this
              toggle, which shows the current section and the user's avatar;
              it is hidden on desktop (see styles.css). */}
          <button
            type="button"
            className="nav-toggle"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="nav-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="nav-toggle-icon" aria-hidden="true">☰</span>
            <span className="nav-toggle-label">
              {tabs.find((t) => t.id === activeTab)?.label ?? 'Menu'}
            </span>
            <img className="nav-toggle-avatar" src={me.avatarUrl} alt="" />
          </button>
          <div id="nav-menu" className={`nav-menu ${menuOpen ? 'open' : ''}`}>
            <div className="tabs" role="tablist" aria-label="Report sections">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={`tab ${activeTab === t.id ? 'active' : ''}`}
                  onClick={() => navigate(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="nav-user">
              <span className="nav-user-name">{me.login}</span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setMenuOpen(false);
                  onSignOut();
                }}
              >
                Sign out
              </button>
            </div>
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
        {activeTab === 'admin' && (
          <Suspense fallback={<div className="center-state"><span className="spinner" /></div>}>
            <AdminPanel />
          </Suspense>
        )}
      </div>
      <Footer />
    </>
  );
}

function UserChip({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <div className="user-chip">
      <img src={me.avatarUrl} alt="" />
      <span className="small muted">{me.login}</span>
      <button className="btn ghost small" style={{ padding: '6px 12px' }} onClick={onSignOut}>
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
