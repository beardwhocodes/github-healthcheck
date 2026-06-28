// Minimal authenticated GitHub REST client. Only ever calls api.github.com with
// validated owner/repo path segments — it never fetches user-supplied URLs, so
// the "scan any repo" feature carries no SSRF surface.

const API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

// Validate a GitHub owner or repo name (path segment). Rejects anything that
// could escape the path or hit a different host.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-_.]{0,99}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

// Enforce the path-segment invariant inside the client so it holds by
// construction rather than depending on every caller to pre-validate. A bad
// name is a programming/abuse error, surfaced as a 400-class GitHubApiError.
function assertValidName(name: string): void {
  if (!isValidName(name)) {
    throw new GitHubApiError(`Invalid GitHub owner/repo name: ${name}`, 400);
  }
}

// Cap README text before the heuristics engine parses it. The regex passes are
// linear, but an uncapped ~1 MB README is still wasted CPU per scan (amplified by
// clone detection + the daily cron); 256 KB is far beyond any real README.
const README_MAX_CHARS = 256 * 1024;

function b64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface RawCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string } | null;
}

export interface GitHubClientOptions {
  // Bounded retry cap for transient failures (5xx / secondary rate limits).
  maxRetries?: number;
  // Injectable for tests so backoff doesn't add real wall-clock delay.
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Transient failures worth a bounded retry: any 5xx, GitHub secondary rate
// limits (429, or 403 carrying a Retry-After hint). A plain 403 with no
// Retry-After is an auth/permission error and must NOT be retried.
function isRetryable(resp: Response): boolean {
  if (resp.status >= 500) return true;
  if (resp.status === 429) return true;
  if (resp.status === 403 && resp.headers.get('retry-after') !== null) return true;
  return false;
}

// Honor Retry-After (seconds) when present, else exponential backoff. Both are
// capped so a hostile/garbled header can't stall the worker.
function retryDelayMs(resp: Response, attempt: number): number {
  const retryAfter = resp.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_CAP_MS);
    }
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

export class GitHubClient {
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly token: string | null,
    options: GitHubClientOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? defaultSleep;
  }

  // Build a validated, percent-encoded /repos/{owner}/{name} base. Validation
  // and encoding live here (not at call sites) so the SSRF invariant holds for
  // every endpoint by construction.
  private repoBase(owner: string, name: string): string {
    assertValidName(owner);
    assertValidName(name);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private async request(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'GitHub-Healthcheck',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`${API}${path}`, { headers });

      if (resp.status === 403 || resp.status === 429) {
        const remaining = resp.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
          // Primary rate limit: reset can be far off, so fail fast with a clear
          // message rather than burning retries waiting for it.
          throw new GitHubApiError('GitHub rate limit exceeded — try again shortly.', 429);
        }
      }

      if (attempt < this.maxRetries && isRetryable(resp)) {
        const delayMs = retryDelayMs(resp, attempt);
        console.warn(
          `GitHub ${resp.status} for ${path}; retrying in ${delayMs}ms ` +
            `(attempt ${attempt + 1}/${this.maxRetries})`,
        );
        await this.sleep(delayMs);
        continue;
      }
      return resp;
    }
  }

  private async json<T>(path: string): Promise<T> {
    const resp = await this.request(path);
    if (!resp.ok) {
      throw new GitHubApiError(`GitHub API ${resp.status} for ${path}`, resp.status);
    }
    return (await resp.json()) as T;
  }

  async getAuthenticatedUser(): Promise<Record<string, unknown>> {
    return this.json('/user');
  }

  async getUser(login: string): Promise<Record<string, unknown>> {
    assertValidName(login);
    return this.json(`/users/${encodeURIComponent(login)}`);
  }

  // List repos. For the authenticated owner we use /user/repos (includes private
  // when scope allows); for any other login we use the public endpoint.
  async listRepos(opts: {
    login: string;
    self: boolean;
    perPage?: number;
    maxPages?: number;
  }): Promise<Record<string, unknown>[]> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 3;
    const repos: Record<string, unknown>[] = [];

    if (!opts.self) assertValidName(opts.login);
    const login = encodeURIComponent(opts.login);
    for (let page = 1; page <= maxPages; page++) {
      const path = opts.self
        ? `/user/repos?affiliation=owner&sort=pushed&per_page=${perPage}&page=${page}`
        : `/users/${login}/repos?sort=pushed&per_page=${perPage}&page=${page}`;
      const batch = await this.json<Record<string, unknown>[]>(path);
      repos.push(...batch);
      if (batch.length < perPage) break;
    }
    return repos;
  }

  async getRepo(owner: string, name: string): Promise<Record<string, unknown>> {
    return this.json(this.repoBase(owner, name));
  }

  async getReadme(owner: string, name: string): Promise<string | null> {
    const resp = await this.request(`${this.repoBase(owner, name)}/readme`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new GitHubApiError(`readme ${resp.status}`, resp.status);
    const data = (await resp.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    const text = data.encoding === 'base64' ? b64ToUtf8(data.content) : data.content;
    return text.length > README_MAX_CHARS ? text.slice(0, README_MAX_CHARS) : text;
  }

  async getRecentCommits(owner: string, name: string, perPage = 5): Promise<RawCommit[]> {
    const resp = await this.request(`${this.repoBase(owner, name)}/commits?per_page=${perPage}`);
    if (resp.status === 409 || resp.status === 404) return []; // empty repo
    if (!resp.ok) throw new GitHubApiError(`commits ${resp.status}`, resp.status);
    return (await resp.json()) as RawCommit[];
  }

  async getCommitFiles(owner: string, name: string, sha: string): Promise<string[]> {
    const resp = await this.request(
      `${this.repoBase(owner, name)}/commits/${encodeURIComponent(sha)}`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { files?: { filename: string }[] };
    return (data.files ?? []).map((f) => f.filename);
  }

  // Contributor count via the Link header's last-page number (cheap; avoids
  // paging the whole list). Mirrors git-malware-finder's approach.
  async getContributorsCount(owner: string, name: string): Promise<number | null> {
    const resp = await this.request(
      `${this.repoBase(owner, name)}/contributors?per_page=1&anon=true`,
    );
    if (!resp.ok) return null;
    const link = resp.headers.get('link');
    const match = link?.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (match && match[1]) return Number.parseInt(match[1], 10);
    const data = (await resp.json()) as unknown[];
    return Array.isArray(data) ? data.length : null;
  }

  async getReleaseAssets(
    owner: string,
    name: string,
    cap = 500,
  ): Promise<{ name: string; downloadUrl: string; sizeBytes: number }[]> {
    const resp = await this.request(`${this.repoBase(owner, name)}/releases?per_page=5`);
    if (!resp.ok) return [];
    const releases = (await resp.json()) as {
      assets?: { name: string; browser_download_url: string; size: number }[];
    }[];
    return releases
      .flatMap((r) =>
        (r.assets ?? []).map((a) => ({
          name: a.name,
          downloadUrl: a.browser_download_url,
          sizeBytes: a.size,
        })),
      )
      .slice(0, cap);
  }

  async getTreePaths(
    owner: string,
    name: string,
    branch: string,
    cap = 500,
  ): Promise<string[]> {
    const resp = await this.request(
      `${this.repoBase(owner, name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { tree?: { path: string; type: string }[] };
    return (data.tree ?? [])
      .filter((t) => t.type === 'blob')
      .map((t) => t.path)
      .slice(0, cap);
  }

  // Revoke this client's OAuth access token at GitHub, dropping our app's
  // authorization for the user (GitHub's "Delete an app token" endpoint). Unlike
  // every other call it authenticates with HTTP Basic client_id:client_secret —
  // not the user's Bearer token — and passes the token to revoke in the body.
  // Best-effort: returns true when there's nothing to revoke or GitHub confirms
  // it (204), or when the token is already unknown (404); returns false on any
  // other status or a network error so account deletion can proceed regardless.
  async revokeOAuthToken(clientId: string, clientSecret: string): Promise<boolean> {
    if (!this.token) return true;
    try {
      const resp = await fetch(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'GitHub-Healthcheck',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: this.token }),
      });
      return resp.status === 204 || resp.status === 404;
    } catch {
      return false;
    }
  }

  // Search repositories by name. Used for clone/impersonation detection.
  async searchRepos(
    query: string,
    perPage = 20,
  ): Promise<Record<string, unknown>[]> {
    const resp = await this.request(
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=updated`,
    );
    if (!resp.ok) throw new GitHubApiError(`search ${resp.status}`, resp.status);
    const data = (await resp.json()) as { items?: Record<string, unknown>[] };
    return data.items ?? [];
  }
}
