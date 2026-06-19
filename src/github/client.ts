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

export class GitHubClient {
  constructor(private readonly token: string | null) {}

  private async request(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'GitHub-Healthcheck',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const resp = await fetch(`${API}${path}`, { headers });
    if (resp.status === 403 || resp.status === 429) {
      const remaining = resp.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        throw new GitHubApiError('GitHub rate limit exceeded — try again shortly.', 429);
      }
    }
    return resp;
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
    return this.json(`/users/${login}`);
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

    for (let page = 1; page <= maxPages; page++) {
      const path = opts.self
        ? `/user/repos?affiliation=owner&sort=pushed&per_page=${perPage}&page=${page}`
        : `/users/${opts.login}/repos?sort=pushed&per_page=${perPage}&page=${page}`;
      const batch = await this.json<Record<string, unknown>[]>(path);
      repos.push(...batch);
      if (batch.length < perPage) break;
    }
    return repos;
  }

  async getRepo(owner: string, name: string): Promise<Record<string, unknown>> {
    return this.json(`/repos/${owner}/${name}`);
  }

  async getReadme(owner: string, name: string): Promise<string | null> {
    const resp = await this.request(`/repos/${owner}/${name}/readme`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new GitHubApiError(`readme ${resp.status}`, resp.status);
    const data = (await resp.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return data.encoding === 'base64' ? b64ToUtf8(data.content) : data.content;
  }

  async getRecentCommits(owner: string, name: string, perPage = 5): Promise<RawCommit[]> {
    const resp = await this.request(`/repos/${owner}/${name}/commits?per_page=${perPage}`);
    if (resp.status === 409 || resp.status === 404) return []; // empty repo
    if (!resp.ok) throw new GitHubApiError(`commits ${resp.status}`, resp.status);
    return (await resp.json()) as RawCommit[];
  }

  async getCommitFiles(owner: string, name: string, sha: string): Promise<string[]> {
    const resp = await this.request(`/repos/${owner}/${name}/commits/${sha}`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { files?: { filename: string }[] };
    return (data.files ?? []).map((f) => f.filename);
  }

  // Contributor count via the Link header's last-page number (cheap; avoids
  // paging the whole list). Mirrors git-malware-finder's approach.
  async getContributorsCount(owner: string, name: string): Promise<number | null> {
    const resp = await this.request(
      `/repos/${owner}/${name}/contributors?per_page=1&anon=true`,
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
  ): Promise<{ name: string; downloadUrl: string; sizeBytes: number }[]> {
    const resp = await this.request(`/repos/${owner}/${name}/releases?per_page=5`);
    if (!resp.ok) return [];
    const releases = (await resp.json()) as {
      assets?: { name: string; browser_download_url: string; size: number }[];
    }[];
    return releases.flatMap((r) =>
      (r.assets ?? []).map((a) => ({
        name: a.name,
        downloadUrl: a.browser_download_url,
        sizeBytes: a.size,
      })),
    );
  }

  async getTreePaths(
    owner: string,
    name: string,
    branch: string,
    cap = 500,
  ): Promise<string[]> {
    const resp = await this.request(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { tree?: { path: string; type: string }[] };
    return (data.tree ?? [])
      .filter((t) => t.type === 'blob')
      .map((t) => t.path)
      .slice(0, cap);
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
