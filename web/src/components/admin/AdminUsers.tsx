import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { AdminUser, AdminUserBase } from '../../api.js';
import { timeAgo } from '../../ui.js';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All users' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'admin', label: 'Admins' },
] as const;

export function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(() => {
    setUsers(null);
    setError(null);
    api.admin
      .users({ query, status })
      .then((res) => setUsers(res.users))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load users.'),
      );
  }, [query, status]);

  useEffect(() => {
    load();
  }, [load]);

  // Mutations return only the durable base record. Merge it onto the existing row
  // so the list-only fields (recentScans/velocity) survive — replacing the row
  // would drop them and crash the render that reads recentScans.toLocaleString().
  function applyUser(base: AdminUserBase) {
    setUsers((prev) =>
      prev ? prev.map((u) => (u.login === base.login ? { ...u, ...base } : u)) : prev,
    );
  }

  async function runAction(login: string, action: () => Promise<{ user: AdminUserBase }>) {
    setPending(login);
    setActionError(null);
    try {
      const { user } = await action();
      applyUser(user);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPending(null);
    }
  }

  function suspend(login: string) {
    const reason = window.prompt(`Reason for suspending ${login}?`);
    if (!reason) return;
    void runAction(login, () => api.admin.suspend(login, reason));
  }

  function unsuspend(login: string) {
    void runAction(login, () => api.admin.unsuspend(login));
  }

  function toggleRole(user: AdminUser) {
    const nextRole = user.role === 'admin' ? 'user' : 'admin';
    void runAction(user.login, () => api.admin.setRole(user.login, nextRole));
  }

  return (
    <div>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input
          className="text-input grow"
          type="search"
          placeholder="Search by login or name…"
          aria-label="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select-input"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn ghost small" onClick={load}>
          Refresh
        </button>
      </form>

      {actionError && <div className="banner error mt16">{actionError}</div>}

      {error ? (
        <div className="banner error mt16">{error}</div>
      ) : !users ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : users.length === 0 ? (
        <p className="faint center-state">No users match.</p>
      ) : (
        <div className="table-scroll mt16">
          <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Scans</th>
              <th>Last seen</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isPending = pending === user.login;
              const isSuspended = user.suspendedAt != null;
              const isAdmin = user.role === 'admin';
              const velocityClass =
                user.velocity === 'abuse'
                  ? 'velocity-abuse'
                  : user.velocity === 'warn'
                    ? 'velocity-warn'
                    : 'muted';
              return (
                <tr key={user.login}>
                  <td>
                    <div className="row-user">
                      {user.avatarUrl && (
                        <img src={user.avatarUrl} alt="" width={28} height={28} />
                      )}
                      <div>
                        <b>{user.login}</b>
                        {user.name && (
                          <div className="muted small">{user.name}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    {isAdmin ? (
                      <span className="pill info">admin</span>
                    ) : (
                      <span className="pill">user</span>
                    )}
                  </td>
                  <td>
                    {isSuspended ? (
                      <>
                        <span className="pill danger">suspended</span>
                        {user.suspendedReason && (
                          <div className="muted small">{user.suspendedReason}</div>
                        )}
                      </>
                    ) : (
                      <span className="pill ok">active</span>
                    )}
                  </td>
                  <td>
                    <span className={velocityClass}>
                      {user.scanCount.toLocaleString()} total ·{' '}
                      {user.recentScans.toLocaleString()} today
                    </span>
                  </td>
                  <td className="muted small">
                    {timeAgo(new Date(user.lastSeenAt).toISOString())}
                  </td>
                  <td>
                    <div className="toolbar">
                      {!isSuspended && !isAdmin && (
                        <button
                          type="button"
                          className="btn danger small"
                          disabled={isPending}
                          onClick={() => suspend(user.login)}
                        >
                          Suspend
                        </button>
                      )}
                      {isSuspended && (
                        <button
                          type="button"
                          className="btn small"
                          disabled={isPending}
                          onClick={() => unsuspend(user.login)}
                        >
                          Unsuspend
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={isPending}
                        onClick={() => toggleRole(user)}
                      >
                        {isAdmin ? 'Make user' : 'Make admin'}
                      </button>
                    </div>
                  </td>
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
