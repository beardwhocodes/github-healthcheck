import type { RiskBand, Severity } from './api.js';

export const BAND_COLOR: Record<RiskBand, string> = {
  safe: 'var(--safe)',
  low: 'var(--low)',
  elevated: 'var(--elevated)',
  high: 'var(--high)',
  critical: 'var(--critical)',
};

export const BAND_LABEL: Record<RiskBand, string> = {
  safe: 'Safe',
  low: 'Low risk',
  elevated: 'Elevated',
  high: 'High risk',
  critical: 'Critical',
};

export function bandClass(band: RiskBand): string {
  return `band-${band}`;
}

export function sevClass(sev: Severity): string {
  return `sev-${sev}`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

// Return the URL only if it is https — otherwise undefined, so a stored
// javascript:/data: URI can never become a clickable href. Defense-in-depth
// alongside the server-side scheme check; the admin Reports view in particular
// renders user-submitted URLs.
export function safeExternalUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
