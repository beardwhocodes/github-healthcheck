import { useEffect, useState } from 'react';

import { ApiError, api } from '../../api.js';
import type { AbuseCategory, AdminReport, ReportStatus } from '../../api.js';
import { timeAgo } from '../../ui.js';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'reported', label: 'Reported' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'takendown', label: 'Taken down' },
];

const REPORT_STATUSES: { value: ReportStatus; label: string }[] = [
  { value: 'reported', label: 'Reported' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'takendown', label: 'Taken down' },
];

const CATEGORY_PILL: Record<AbuseCategory, { className: string; label: string }> = {
  malware: { className: 'pill danger', label: 'Malware' },
  impersonation: { className: 'pill warn', label: 'Impersonation' },
};

export function AdminReports() {
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  function load(status: string) {
    setReports(null);
    setError(null);
    api.admin
      .reports(status)
      .then((res) => {
        setReports(res.reports);
        setNoteDrafts(
          Object.fromEntries(res.reports.map((r) => [r.id, r.adminNotes ?? ''])),
        );
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load reports.'),
      );
  }

  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  function applyUpdate(updated: AdminReport) {
    setReports((prev) =>
      prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev,
    );
    setNoteDrafts((prev) => ({ ...prev, [updated.id]: updated.adminNotes ?? '' }));
  }

  function changeStatus(id: string, status: ReportStatus) {
    setError(null);
    api.admin
      .updateReport(id, { status })
      .then((res) => applyUpdate(res.report))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not update report.'),
      );
  }

  function saveNotes(id: string) {
    setError(null);
    api.admin
      .updateReport(id, { notes: noteDrafts[id] ?? '' })
      .then((res) => applyUpdate(res.report))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not save notes.'),
      );
  }

  return (
    <div>
      <div className="toolbar">
        <label className="field-label" htmlFor="report-status-filter">
          Status
        </label>
        <select
          id="report-status-filter"
          className="select-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button className="btn ghost small" type="button" onClick={() => load(filter)}>
          Refresh
        </button>
      </div>

      {error && <div className="banner error mt16">{error}</div>}

      {reports === null ? (
        <div className="center-state">
          <span className="spinner" />
        </div>
      ) : reports.length === 0 ? (
        <p className="faint small mt16">No reports yet.</p>
      ) : (
        <table className="data-table mt16">
          <thead>
            <tr>
              <th>Suspect repo</th>
              <th>Copies</th>
              <th>Reporter</th>
              <th>Confidence</th>
              <th>Category</th>
              <th>Status</th>
              <th>Notes</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id}>
                <td>
                  {report.suspectUrl ? (
                    <a
                      href={report.suspectUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {report.suspectRepo}
                    </a>
                  ) : (
                    report.suspectRepo
                  )}
                </td>
                <td className="muted small">{report.sourceRepo ?? '—'}</td>
                <td>{report.reporterLogin}</td>
                <td>{report.confidence != null ? `${report.confidence}/100` : '—'}</td>
                <td>
                  {report.category ? (
                    <span className={CATEGORY_PILL[report.category].className}>
                      {CATEGORY_PILL[report.category].label}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <select
                    className="select-input"
                    aria-label={`Status for ${report.suspectRepo}`}
                    value={report.status}
                    onChange={(e) =>
                      changeStatus(report.id, e.target.value as ReportStatus)
                    }
                  >
                    {REPORT_STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="row-between">
                    <input
                      className="text-input"
                      type="text"
                      aria-label={`Notes for ${report.suspectRepo}`}
                      value={noteDrafts[report.id] ?? ''}
                      onChange={(e) =>
                        setNoteDrafts((prev) => ({
                          ...prev,
                          [report.id]: e.target.value,
                        }))
                      }
                    />
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => saveNotes(report.id)}
                    >
                      Save
                    </button>
                  </div>
                </td>
                <td className="muted small">
                  {timeAgo(new Date(report.updatedAt).toISOString())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
