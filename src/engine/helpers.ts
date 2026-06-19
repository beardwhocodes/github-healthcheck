import { BOT_AUTHOR_PATTERNS, PROSE_BINARY_EXTENSIONS } from './constants.js';

// Extract URLs from markdown/text: inline links [t](url), images ![a](url),
// reference definitions [id]: url, angle autolinks <url>, html href/src
// attributes, and bare URLs. Returns lowercased URLs.
export function extractUrls(text: string): string[] {
  const urls = new Set<string>();

  const patterns = [
    /!?\[[^\]]*\]\(\s*<?([^()\s>]+)>?[^)]*\)/g, // inline [t](url) / ![a](url)
    /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gim, // reference def [id]: url
    /<((?:https?:\/\/)[^\s<>]+)>/gi, // angle autolink <url>
    /(?:href|src)\s*=\s*["']([^"']+)["']/gi, // html attributes
    /\bhttps?:\/\/[^\s"'<>)\]]+/gi, // bare url
  ];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const url = (match[1] ?? match[0]).trim();
      if (url) {
        urls.add(url.toLowerCase());
      }
    }
  }

  return [...urls];
}

// The path portion of a URL (host stripped), or the raw string for a relative
// path. Used so "https://github.com" does NOT read as a ".com" binary.
export function pathPart(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname.toLowerCase();
  } catch {
    return (urlOrPath.toLowerCase().split(/[?#]/)[0] ?? '');
  }
}

// True if a URL's PATH (not host) ends in one of the given extensions.
export function urlHasExtension(urlOrPath: string, extensions: readonly string[]): boolean {
  const path = pathPart(urlOrPath);
  return extensions.some((ext) => path.endsWith(ext));
}

// Find bare binary/archive *filename* tokens in prose, e.g. "Setup.exe",
// "app-1.0.zip". Requires a real name char before the dot and uses the curated
// PROSE_BINARY_EXTENSIONS set, so hostnames and English prose don't match.
const PROSE_TOKEN_RE = new RegExp(
  `\\b[\\w-][\\w.-]*\\.(${PROSE_BINARY_EXTENSIONS.join('|')})\\b`,
  'gi',
);

export function findBinaryFilenameTokens(text: string): string[] {
  const out = new Set<string>();
  let match: RegExpExecArray | null;
  PROSE_TOKEN_RE.lastIndex = 0;
  while ((match = PROSE_TOKEN_RE.exec(text)) !== null) {
    // Exclude tokens that are actually hostnames (preceded by "//" or "@", or
    // where the token contains no separator and looks like "name.tld").
    out.add(match[0].toLowerCase());
  }
  return [...out];
}

// Hostname of a URL, lowercased, without leading "www." (null if unparseable).
export function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

// Does a filename/path point at a binary/archive of one of the given extensions?
export function hasExtension(pathOrUrl: string, extensions: readonly string[]): boolean {
  const lower = pathOrUrl.toLowerCase().split(/[?#]/)[0] ?? '';
  return extensions.some((ext) => lower.endsWith(ext));
}

export function isBotAuthor(authorName: string): boolean {
  return BOT_AUTHOR_PATTERNS.some((re) => re.test(authorName));
}

// Whole-days difference between an ISO date and `now` (defaults to current time).
// Pure given an explicit `now`, which the tests always provide.
export function daysBetween(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return Number.POSITIVE_INFINITY;
  }
  return (now - then) / (1000 * 60 * 60 * 24);
}

export function hoursBetween(isoLater: string, isoEarlier: string): number {
  const later = new Date(isoLater).getTime();
  const earlier = new Date(isoEarlier).getTime();
  if (Number.isNaN(later) || Number.isNaN(earlier)) {
    return Number.POSITIVE_INFINITY;
  }
  return (later - earlier) / (1000 * 60 * 60);
}

// Truncate evidence strings so the report stays readable.
export function clip(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
