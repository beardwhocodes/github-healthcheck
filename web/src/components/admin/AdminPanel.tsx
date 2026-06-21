import { useState } from 'react';

import { AdminAudit } from './AdminAudit.js';
import { AdminInbox } from './AdminInbox.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminReports } from './AdminReports.js';
import { AdminScans } from './AdminScans.js';
import { AdminUsers } from './AdminUsers.js';

type Section = 'overview' | 'users' | 'scans' | 'inbox' | 'reports' | 'audit';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'scans', label: 'Scan log' },
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
      {section === 'scans' && <AdminScans />}
      {section === 'inbox' && <AdminInbox />}
      {section === 'reports' && <AdminReports />}
      {section === 'audit' && <AdminAudit />}
    </div>
  );
}
