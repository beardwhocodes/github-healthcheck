import type { Finding, RiskBand, Severity } from '../api.js';
import { BAND_COLOR, BAND_LABEL, bandClass, sevClass } from '../ui.js';

export function Gauge({ score, band }: { score: number; band: RiskBand }) {
  return (
    <div
      className="gauge"
      style={{ ['--p' as string]: score, ['--c' as string]: BAND_COLOR[band] }}
      role="img"
      aria-label={`Risk score ${score} of 100, ${BAND_LABEL[band]}`}
    >
      <div>
        <div className="num">{score}</div>
        <div className="denom">/ 100</div>
      </div>
    </div>
  );
}

export function MiniGauge({ score, band }: { score: number; band: RiskBand }) {
  return (
    <div
      className="mini-gauge"
      style={{ ['--p' as string]: score, ['--c' as string]: BAND_COLOR[band] }}
      aria-hidden="true"
    >
      {score}
    </div>
  );
}

export function BandBadge({ band }: { band: RiskBand }) {
  return (
    <span className={`badge ${bandClass(band)}`}>
      <span aria-hidden>●</span> {BAND_LABEL[band]}
    </span>
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return <span className={`sev-dot ${sevClass(severity)}`} aria-label={severity} />;
}

export function FindingItem({ finding }: { finding: Finding }) {
  return (
    <div className="finding">
      <SeverityDot severity={finding.severity} />
      <div className="body">
        <div className="title">{finding.title}</div>
        <div className="detail">{finding.detail}</div>
        {finding.remediation && <div className="remediation">→ {finding.remediation}</div>}
        {finding.evidence && finding.evidence.length > 0 && (
          <div className="evidence">
            {finding.evidence.map((e, i) => (
              <span className="chip" key={i}>
                {e}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
