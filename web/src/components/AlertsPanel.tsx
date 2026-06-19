import { useEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import type { AlertsStatus } from '../api.js';
import { timeAgo } from '../ui.js';

export function AlertsPanel({ defaultEmail }: { defaultEmail?: string }) {
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .alerts()
      .then(setStatus)
      .catch(() => setStatus({ subscribed: false, email: null, lastRunAt: null }));
  }, []);

  async function subscribe() {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.subscribe(email.trim());
      setStatus(res);
      setNotice(
        'Alerts enabled. We recorded your current clones as a baseline and will email you only when a NEW one appears.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enable alerts.');
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(await api.unsubscribe());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable alerts.');
    } finally {
      setBusy(false);
    }
  }

  const subscribed = status?.subscribed === true;

  return (
    <div className="card">
      <h3 className="section-title">Future-impersonation alerts</h3>
      <p className="muted small" style={{ margin: '4px 0 14px', maxWidth: 620 }}>
        New clones can appear at any time. Subscribe and a daily background scan will re-check your
        repositories for fresh malicious copies and email you the moment one shows up — so you can
        report it before it harms anyone trusting your name.
      </p>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok mt8">{notice}</div>}

      {subscribed ? (
        <div className="mt8">
          <div className="banner info">
            ✅ Alerts are on for <b>{status?.email}</b>. Last scan: {timeAgo(status?.lastRunAt ? new Date(status.lastRunAt).toISOString() : null)}.
          </div>
          <button className="btn danger mt16" onClick={unsubscribe} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Turn off alerts'}
          </button>
        </div>
      ) : (
        <div className="input-row mt8">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && subscribe()}
            aria-label="Email for impersonation alerts"
          />
          <button className="btn" onClick={subscribe} disabled={busy || !email.trim()}>
            {busy ? <span className="spinner" /> : 'Enable alerts'}
          </button>
        </div>
      )}
    </div>
  );
}
