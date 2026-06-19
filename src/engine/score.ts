import { BAND_THRESHOLDS } from './constants.js';
import type { Finding, RiskBand, Severity } from './types.js';

// A single decisive signal should not be diluted by the diminishing-returns
// math: a committed loader or a password-locked "build" is near-certain malware
// on its own, so the highest-severity finding sets a floor on the score.
const SEVERITY_FLOOR: Record<Severity, number> = {
  critical: 70, // -> critical band
  high: 35, // -> elevated band
  medium: 0,
  low: 0,
  info: 0,
};

// Combine finding weights into a 0..100 risk score.
//
// We use diminishing-returns accumulation rather than a raw sum: each
// additional finding adds a fraction of the remaining headroom to 100. This
// keeps a long tail of minor findings from trivially saturating the scale,
// while the per-severity floor guarantees a lone decisive signal still scores.
export function scoreFromFindings(findings: Finding[]): number {
  const sorted = [...findings].sort((a, b) => b.weight - a.weight);

  let remaining = 100;
  let score = 0;

  for (const finding of sorted) {
    const contribution = (finding.weight / 100) * remaining;
    score += contribution;
    remaining -= contribution;
  }

  const floor = findings.reduce((max, f) => Math.max(max, SEVERITY_FLOOR[f.severity]), 0);
  return Math.round(Math.min(100, Math.max(score, floor)));
}

export function bandForScore(score: number): RiskBand {
  for (const { band, min } of BAND_THRESHOLDS) {
    if (score >= min) {
      return band;
    }
  }

  return 'safe';
}

// Highest band across a set of bands (for rollups).
const BAND_ORDER: RiskBand[] = ['safe', 'low', 'elevated', 'high', 'critical'];

export function maxBand(bands: RiskBand[]): RiskBand {
  return bands.reduce<RiskBand>((acc, band) => {
    return BAND_ORDER.indexOf(band) > BAND_ORDER.indexOf(acc) ? band : acc;
  }, 'safe');
}

export function isFlagged(band: RiskBand): boolean {
  return band === 'high' || band === 'critical';
}
