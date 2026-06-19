import type { AccountReport } from '../api.js';
import { fmtDate } from '../ui.js';
import { BandBadge, FindingItem, Gauge } from './Primitives.js';
import { RepoReportCard } from './RepoReportCard.js';

export function AccountReportView({
  report,
  scanned,
  totalRepos,
}: {
  report: AccountReport;
  scanned?: number;
  totalRepos?: number;
}) {
  const { account, summary } = report;

  return (
    <div>
      <div className="card">
        <div className="summary-head">
          <Gauge score={report.score} band={report.band} />
          {account.avatarUrl && (
            <img
              src={account.avatarUrl}
              alt=""
              width={56}
              height={56}
              style={{ borderRadius: '50%', border: '1px solid var(--border)' }}
            />
          )}
          <div className="meta">
            <div className="row-between">
              <h2>
                <a href={account.htmlUrl} target="_blank" rel="noreferrer noopener">
                  {account.login}
                </a>
              </h2>
              <BandBadge band={report.band} />
            </div>
            <div className="stat-row">
              <span>
                <b>{summary.reposScanned}</b> repos scanned
                {typeof totalRepos === 'number' && totalRepos > (scanned ?? summary.reposScanned)
                  ? ` (of ${totalRepos})`
                  : ''}
              </span>
              <span>
                <b style={{ color: summary.flaggedRepos ? 'var(--high)' : 'var(--safe)' }}>
                  {summary.flaggedRepos}
                </b>{' '}
                flagged
              </span>
              <span>
                <b>{account.followers}</b> followers
              </span>
              <span>created {fmtDate(account.createdAt)}</span>
              {account.twoFactorEnabled === false && (
                <span style={{ color: 'var(--high)' }}>2FA off</span>
              )}
            </div>
          </div>
        </div>

        {report.findings.length > 0 && (
          <div className="mt16">
            {report.findings.map((f) => (
              <FindingItem finding={f} key={f.id} />
            ))}
          </div>
        )}
      </div>

      <div className="mt24">
        <div className="row-between">
          <h3 className="section-title">Repositories</h3>
          <span className="faint small">highest risk first</span>
        </div>
        <div className="mt8">
          {report.repoReports.length === 0 && (
            <p className="muted">No repositories found for this account.</p>
          )}
          {report.repoReports.map((r, i) => (
            <RepoReportCard
              report={r}
              key={r.repo.fullName}
              defaultOpen={i === 0 && r.findings.length > 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
