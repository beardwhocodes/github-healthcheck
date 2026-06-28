import { useState } from 'react';

import { AdminAudit } from './AdminAudit.js';
import { AdminInbox } from './AdminInbox.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminReports } from './AdminReports.js';
import { AdminUsers } from './AdminUsers.js';

// The per-scan "Scan log" tab was removed with the identity-linked scans table.
// Aggregate scan analytics (per-day chart + per-kind totals) live in Overview.
type Section = 'overview' | 'users' | 'inbox' | 'reports' | 'audit';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'reports', label: 'Reported repos' },
  { id: 'audit', label: 'Audit log' },
];

export function AdminPanel() {
  const [section, setSection] = useState<Section>('overview');

  return (
    <div>
      <div className="sub-tabs" role="tablist" aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            className={`sub-tab ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'overview' && <AdminOverview />}
      {section === 'users' && <AdminUsers />}
      {section === 'inbox' && <AdminInbox />}
      {section === 'reports' && <AdminReports />}
      {section === 'audit' && <AdminAudit />}
    </div>
  );
}
