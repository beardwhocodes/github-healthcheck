import { BOT_AUTHOR_PATTERNS } from './constants.js';

// Extract URLs from markdown/text: markdown links [t](url), images ![a](url),
// html href/src attributes, and bare URLs. Returns lowercased URLs.
export function extractUrls(text: string): string[] {
  const urls = new Set<string>();

  const mdLink = /!?\[[^\]]*\]\(\s*<?([^()\s>]+)>?[^)]*\)/g;
  const htmlAttr = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const bare = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

  for (const re of [mdLink, htmlAttr, bare]) {
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
