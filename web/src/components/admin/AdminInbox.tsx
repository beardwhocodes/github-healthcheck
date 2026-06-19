import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { ContactMessage, MessageStatus } from '../../api.js';
import { fmtDate } from '../../ui.js';

const STATUS_PILL: Record<MessageStatus, string> = {
  open: 'pill warn',
  read: 'pill',
  resolved: 'pill ok',
};

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function AdminInbox() {
  const [filter, setFilter] = useState<string>('all');
  const [messages, setMessages] = useState<ContactMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  function load(status: string): void {
    setMessages(null);
    setError(null);
    api.admin
      .messages(status)
      .then((res) => setMessages(res.messages))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the inbox.'),
      );
  }

  useEffect(() => {
    load(filter);
  }, [filter]);

  function replaceMessage(updated: ContactMessage): void {
    setMessages((prev) =>
      prev ? prev.map((m) => (m.id === updated.id ? updated : m)) : prev,
    );
  }

  function mutate(id: string, patch: { status?: MessageStatus; reply?: string }): void {
    setBusyId(id);
    setError(null);
    api.admin
      .updateMessage(id, patch)
      .then((res) => {
        replaceMessage(res.message);
        if (patch.reply !== undefined) {
          setDrafts((prev) => ({ ...prev, [id]: '' }));
        }
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not update the message.'),
      )
      .finally(() => setBusyId(null));
  }

  return (
    <div>
      <div className="toolbar">
        <label className="field-label" htmlFor="inbox-status">
          Status
        </label>
        <select
          id="inbox-status"
          className="select-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="read">Read</option>
          <option value="resolved">Resolved</option>
        </select>
        <button type="button" className="btn ghost small" onClick={() => load(filter)}>
          Refresh
        </button>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {messages === null ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : messages.length === 0 ? (
        <p className="muted center-state">Inbox is empty.</p>
      ) : (
        <div className="mt16">
          {messages.map((m) => {
            const draft = drafts[m.id] ?? '';
            const busy = busyId === m.id;
            return (
              <div className="thread" key={m.id}>
                <div className="thread-head">
                  <b>{m.subject}</b>
                  <span className="row-between" style={{ gap: 8 }}>
                    <span className={STATUS_PILL[m.status]}>{m.status}</span>
                    <span className="faint small">{fmtDate(isoOf(m.createdAt))}</span>
                  </span>
                </div>

                <p className="muted small" style={{ marginTop: 0 }}>
                  from {m.login}
                  {m.email
                    ? ` · ${m.email}`
                    : ' (no email on file — reply won’t be sent by mail)'}
                </p>

                <div className="thread-body">{m.body}</div>

                {m.adminReply && (
                  <div className="thread-reply">
                    <div className="faint small">
                      Reply sent
                      {m.repliedAt ? ` · ${fmtDate(isoOf(m.repliedAt))}` : ''}
                    </div>
                    {m.adminReply}
                  </div>
                )}

                <div className="mt8">
                  <label className="field-label" htmlFor={`reply-${m.id}`}>
                    Reply
                  </label>
                  <textarea
                    id={`reply-${m.id}`}
                    className="text-area"
                    value={draft}
                    placeholder="Write a reply…"
                    disabled={busy}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                    }
                  />
                </div>

                <div className="toolbar mt8">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy || draft.trim().length === 0}
                    onClick={() => mutate(m.id, { reply: draft.trim() })}
                  >
                    Send reply
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => mutate(m.id, { status: 'read' })}
                  >
                    Mark read
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => mutate(m.id, { status: 'resolved' })}
                  >
                    Mark resolved
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
