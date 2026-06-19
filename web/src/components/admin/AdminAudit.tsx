import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { AuditEntry } from '../../api.js';
import { fmtDate, timeAgo } from '../../ui.js';

const ACTION_LABEL: Record<string, string> = {
  suspend_user: 'Suspended user',
  unsuspend_user: 'Unsuspended user',
  set_role: 'Changed role',
  update_message: 'Updated message',
  reply_message: 'Replied to message',
  update_report: 'Updated report',
};

export function AdminAudit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .admin.audit(200)
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load audit log.'));
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!entries) return <div className="center-state"><span className="spinner" /></div>;

  if (entries.length === 0) {
    return <p className="faint small mt16">No admin actions logged yet.</p>;
  }

  return (
    <div className="card">
      <h3 className="section-title">Admin action log</h3>
      <table className="data-table mt16">
        <thead>
          <tr>
            <th>When</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const iso = new Date(entry.createdAt).toISOString();
            return (
              <tr key={entry.id}>
                <td title={fmtDate(iso)}>{timeAgo(iso)}</td>
                <td>{entry.adminLogin}</td>
                <td>
                  <span className="pill">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                </td>
                <td>{entry.target ?? '—'}</td>
                <td className="muted small">{entry.detail ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
