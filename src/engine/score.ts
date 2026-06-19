import { BAND_THRESHOLDS } from './constants.js';
import type { Finding, RiskBand } from './types.js';

// Combine finding weights into a 0..100 risk score.
//
// We use diminishing-returns accumulation rather than a raw sum: each
// additional finding adds a fraction of the remaining headroom to 100. This
// keeps a single decisive signal meaningful while preventing a long tail of
// minor findings from trivially saturating the scale.
export function scoreFromFindings(findings: Finding[]): number {
  const sorted = [...findings].sort((a, b) => b.weight - a.weight);

  let remaining = 100;
  let score = 0;

  for (const finding of sorted) {
    const contribution = (finding.weight / 100) * remaining;
    score += contribution;
    remaining -= contribution;
  }

  return Math.round(Math.min(100, score));
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
