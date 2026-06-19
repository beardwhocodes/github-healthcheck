import { useState } from 'react';

import type { RepoReport } from '../api.js';
import { fmtDate } from '../ui.js';
import { BandBadge, FindingItem, MiniGauge } from './Primitives.js';

export function RepoReportCard({ report, defaultOpen = false }: { report: RepoReport; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const findingCount = report.findings.length;

  return (
    <div className="repo-card">
      <div
        className="repo-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <MiniGauge score={report.score} band={report.band} />
        <div className="name">
          <div className="full">{report.repo.fullName}</div>
          <div className="sub">
            {report.repo.stargazers}★ · created {fmtDate(report.repo.createdAt)}
            {report.repo.isFork ? ' · fork' : ''} ·{' '}
            {findingCount === 0 ? 'no findings' : `${findingCount} finding${findingCount === 1 ? '' : 's'}`}
          </div>
        </div>
        <BandBadge band={report.band} />
        <span className="caret">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="repo-body">
          {findingCount === 0 ? (
            <p className="muted small mt8">
              No campaign indicators detected.{' '}
              <a href={report.repo.htmlUrl} target="_blank" rel="noreferrer noopener">
                View on GitHub ↗
              </a>
            </p>
          ) : (
            <>
              {report.findings.map((f) => (
                <FindingItem finding={f} key={f.id} />
              ))}
              <p className="faint small mt8">
                <a href={report.repo.htmlUrl} target="_blank" rel="noreferrer noopener">
                  View {report.repo.fullName} on GitHub ↗
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
