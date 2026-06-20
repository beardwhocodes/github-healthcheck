import { BOT_AUTHOR_PATTERNS, PROSE_BINARY_EXTENSIONS } from './constants.js';

// Extract URLs from markdown/text: inline links [t](url), images ![a](url),
// reference definitions [id]: url, angle autolinks <url>, html href/src
// attributes, and bare URLs. Returns lowercased URLs.
export function extractUrls(text: string): string[] {
  const urls = new Set<string>();

  const patterns = [
    // inline [t](url) / ![a](url). Capture the URL token right after "](" and
    // stop — we do NOT require the closing ")". The previous form had a trailing
    // [^)]*\) whose run overlapped the URL capture, giving O(n²) backtracking on
    // an unclosed "(" in an attacker-supplied README (measured: ~2.3s @ 40KB).
    /!?\[[^\]]*\]\(\s*<?([^()\s>]+)/g,
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
// "app-1.0.zip". We match a maximal filename run with a SINGLE linear char class
// (no adjacent variable quantifiers → no backtracking), then check the extension
// suffix in JS. The previous regex asserted the extension inside the pattern,
// whose trailing `\.(ext)` overlapped the dotted body and backtracked in O(n²)
// on a long "a.a.a.…" README (measured ~2.7s at 50KB); this is linear.
const PROSE_CANDIDATE_RE = /\b[\w-][\w.-]*/g;
const PROSE_EXT_SET = new Set(PROSE_BINARY_EXTENSIONS.map((e) => e.toLowerCase()));

export function findBinaryFilenameTokens(text: string): string[] {
  const out = new Set<string>();
  let match: RegExpExecArray | null;
  PROSE_CANDIDATE_RE.lastIndex = 0;
  while ((match = PROSE_CANDIDATE_RE.exec(text)) !== null) {
    const token = match[0].replace(/[.-]+$/, '').toLowerCase(); // drop trailing . / -
    const dot = token.lastIndexOf('.');
    if (dot <= 0) continue; // need a real name char before the dot
    if (PROSE_EXT_SET.has(token.slice(dot + 1))) out.add(token);
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

// GitHub-hosted download hosts (releases, raw, codeload). A link to a project's
// own GitHub release is legitimate, scannable distribution — NOT the campaign's
// shortener/file-host pattern — so these URLs do not "arm" the tampering gate.
const GITHUB_HOSTS = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

export function isGithubHostedUrl(url: string): boolean {
  const host = hostnameOf(url);
  return host !== null && GITHUB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
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
