import { useEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import type { ContactMessage } from '../api.js';
import { fmtDate } from '../ui.js';

// Support form for any signed-in user, plus a thread of their past messages and
// any admin replies (two-way support, all in-app).
export function ContactPanel({ defaultEmail }: { defaultEmail?: string }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [messages, setMessages] = useState<ContactMessage[]>([]);

  function loadMessages() {
    api
      .myMessages()
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
  }

  useEffect(loadMessages, []);

  async function submit() {
    if (!subject.trim() || body.trim().length < 5) {
      setError('Add a subject and a few words about your question.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.submitContact({ subject: subject.trim(), body: body.trim(), email: email.trim() || undefined });
      setSent(true);
      setSubject('');
      setBody('');
      loadMessages();
      setTimeout(() => setSent(false), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your message.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h3 className="section-title">Contact us</h3>
        <p className="muted small" style={{ margin: '4px 0 0', maxWidth: 620 }}>
          Questions, a false positive, or something not working? Send us a note. Add your email if
          you&apos;d like a reply by mail.
        </p>

        {error && <div className="banner error mt16">{error}</div>}
        {sent && <div className="banner ok mt16">Thanks — your message is in. We&apos;ll get back to you.</div>}

        <label className="field-label" htmlFor="contact-subject">
          Subject
        </label>
        <input
          id="contact-subject"
          className="text-input"
          value={subject}
          maxLength={160}
          placeholder="Brief summary"
          onChange={(e) => setSubject(e.target.value)}
        />

        <label className="field-label" htmlFor="contact-body">
          Message
        </label>
        <textarea
          id="contact-body"
          className="text-area"
          value={body}
          maxLength={5000}
          placeholder="What's going on?"
          onChange={(e) => setBody(e.target.value)}
        />

        <label className="field-label" htmlFor="contact-email">
          Email <span className="faint">(optional, for a reply)</span>
        </label>
        <input
          id="contact-email"
          className="text-input"
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />

        <button type="button" className="btn mt16" onClick={submit} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Send message'}
        </button>
      </div>

      {messages.length > 0 && (
        <div className="mt24">
          <h3 className="section-title" style={{ marginBottom: 10 }}>
            Your messages
          </h3>
          {messages.map((m) => (
            <div className="thread" key={m.id}>
              <div className="thread-head">
                <b>{m.subject}</b>
                <span className="muted small">{fmtDate(new Date(m.createdAt).toISOString())}</span>
              </div>
              <div className="thread-body">{m.body}</div>
              {m.adminReply ? (
                <div className="thread-reply">
                  <div className="faint small" style={{ marginBottom: 4 }}>
                    Reply from support
                    {m.repliedAt ? ` · ${fmtDate(new Date(m.repliedAt).toISOString())}` : ''}
                  </div>
                  {m.adminReply}
                </div>
              ) : (
                <div className="faint small mt8">Status: {m.status}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
