import { useState } from 'react';

import { loginUrl } from '../api.js';

const FEATURES = [
  {
    icon: '🔬',
    title: 'Self-audit your repos',
    body: 'Every repository scored against the campaign\'s tells: README-only commits, archive download links, password-locked builds, loader.exe-style release assets.',
  },
  {
    icon: '🪪',
    title: 'Catch impersonations',
    body: 'We search GitHub for malicious clones of your repositories — verbatim copies of your code with a single poisoned README.',
  },
  {
    icon: '📊',
    title: 'Account trust score',
    body: 'A 0–100 risk grade for the whole account: age, 2FA, clustered activity, and the worst repo you host.',
  },
  {
    icon: '🔔',
    title: 'Ongoing alerts',
    body: 'A daily background scan emails you the moment a new clone of your work appears — not just a one-time snapshot.',
  },
];

export function Landing() {
  const [includePrivate, setIncludePrivate] = useState(false);

  return (
    <div className="container">
      <div className="hero">
        <h1>
          Is your GitHub being
          <br />
          cloned to spread malware?
        </h1>
        <p className="lede">
          A documented campaign clones real repositories untouched, adds one poisoned README linking
          to a trojan, and ships it under throwaway accounts — ~10,000 of them, undetected for over a
          year. Sign in and get a security report for your account, your repositories, and any copies
          of your work hiding on GitHub.
        </p>
        <div className="cta-row">
          <a className="btn github" href={loginUrl(includePrivate)}>
            <GithubMark /> Sign in with GitHub
          </a>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={includePrivate}
              onChange={(e) => setIncludePrivate(e.target.checked)}
            />
            also scan private repos
          </label>
        </div>
        <p className="faint small mt16">
          {includePrivate
            ? 'Including private repos requires the broad `repo` scope (GitHub OAuth has no read-only private option) — uncheck to stay public-only with minimal access.'
            : 'We request minimal read-only access to your public repositories.'}{' '}
          Your token is encrypted at rest and used only server-side to query GitHub on your behalf —
          it is never exposed to your browser or any third party.
        </p>
      </div>

      <div className="feature-grid">
        {FEATURES.map((f) => (
          <div className="feature" key={f.title}>
            <div className="icon">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </div>

      <p className="faint small mt24" style={{ textAlign: 'center' }}>
        Detection heuristics adapted from{' '}
        <a href="https://orchidfiles.com/github-repositories-distributing-malware/" target="_blank" rel="noreferrer noopener">
          the orchidfiles disclosure
        </a>{' '}
        and the author&apos;s open-source{' '}
        <a href="https://github.com/orchidfiles/git-malware-finder" target="_blank" rel="noreferrer noopener">
          git-malware-finder
        </a>
        .
      </p>
    </div>
  );
}

export function GithubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
