# Third-party notices & attribution

GitHub Healthcheck is released under the MIT License (see `LICENSE`). This file
documents external work it builds on, so the attribution is unambiguous now that
the source is public.

## orchidfiles malware-distribution disclosure

The threat this tool detects — verbatim repository clones carrying a single
poisoned README that links to a trojan, shipped under throwaway accounts — was
publicly documented by orchidfiles:

- Disclosure write-up: https://orchidfiles.com/github-repositories-distributing-malware/
- Reference CLI: https://github.com/orchidfiles/git-malware-finder

### What is and isn't borrowed

- **No source code is copied.** The detection engine in `src/engine/` is a clean,
  independent re-implementation written for this project (pure functions, its own
  scoring model, its own tests). There are no copied files, source headers, or
  code blocks from `git-malware-finder`.
- **The detection *ideas* come from the public disclosure.** The indicators of
  compromise (README-only commits, password-protected archives, loader-style
  release assets, URL-shortener/anonymous-host download links, etc.) are facts
  about a publicly reported campaign, enumerated in the orchidfiles blog post.
  They are encoded here as reviewable data in `src/engine/constants.ts`.

### Upstream license status

As of this writing, `orchidfiles/git-malware-finder` ships **without a license
file** (GitHub reports no detected license; "all rights reserved" by default).
Because this project re-implements the methodology from the public disclosure
rather than copying any of that repository's code, the MIT license on this
project applies only to the original code here. If you intend to reuse or
redistribute, do not assume any rights over the upstream project's source — and
if you are the upstream author and would like the attribution adjusted, please
open an issue.

## "Sign in with GitHub" mark

The GitHub Octocat mark in `web/src/components/Landing.tsx` is used solely for a
standard "Sign in with GitHub" affordance, per GitHub's logo usage guidelines.
It is GitHub's trademark, not part of this project's MIT grant.
