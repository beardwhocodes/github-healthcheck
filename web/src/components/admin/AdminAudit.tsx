import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { AuditEntry } from '../../api.js';
import { fmtDate, timeAgo } from '../../ui.js';

const ACTION_LABEL: Record<string, string> = {
  login: 'Signed in',
  suspend_user: 'Suspended user',
  unsuspend_user: 'Unsuspended user',
  set_role: 'Changed role',
  update_message: 'Updated message',
  reply_message: 'Replied to message',
  update_report: 'Updated report',
};

const CATEGORY_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'logins', label: 'Sign-ins' },
  { value: 'actions', label: 'Admin actions' },
];

export function AdminAudit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [category, setCategory] = useState('all');
  const [error, setError] = useState<string | null>(null);

  function load(cat: string) {
    setEntries(null);
    setError(null);
    api.admin
      .audit(cat)
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load audit log.'));
  }

  useEffect(() => {
    load(category);
  }, [category]);

  return (
    <div>
      <div className="toolbar">
        <label className="field-label" htmlFor="audit-category">
          Show
        </label>
        <select
          id="audit-category"
          className="select-input"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {CATEGORY_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={() => load(category)}>
          Refresh
        </button>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {entries === null ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : entries.length === 0 ? (
        <p className="faint small mt16">Nothing logged yet.</p>
      ) : (
        <div className="table-scroll mt16">
          <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Event</th>
              <th>Target</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const iso = new Date(entry.createdAt).toISOString();
              const isLogin = entry.action === 'login';
              return (
                <tr key={entry.id}>
                  <td className="muted small" title={fmtDate(iso)}>
                    {timeAgo(iso)}
                  </td>
                  <td>{entry.adminLogin}</td>
                  <td>
                    <span className={isLogin ? 'pill info' : 'pill'}>
                      {ACTION_LABEL[entry.action] ?? entry.action}
                    </span>
                  </td>
                  <td>{entry.target ?? '—'}</td>
                  <td className="muted small">{entry.detail ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
