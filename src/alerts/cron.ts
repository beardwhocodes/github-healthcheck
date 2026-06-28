import { decrypt } from '../auth/crypto.js';
import type { Env } from '../env.js';
import type { CloneMatch } from '../engine/types.js';
import { findClonesForRepos } from '../github/clone-detection.js';
import { GitHubApiError, GitHubClient } from '../github/client.js';
import {
  deactivateSubscription,
  getKnownSuspectRepos,
  getWatchedRepos,
  listActiveSubscriptions,
  recordClones,
  rotateUnsubscribeToken,
  setLastRun,
  setLastScanned,
  type Subscription,
} from './store.js';
import { sendImpersonationAlert } from './email.js';

export interface ScanRunResult {
  // Subscribers scanned cleanly (alerts sent or nothing new found).
  scanned: number;
  // Subscribers disabled because their stored OAuth token is dead (401/unusable).
  deactivated: number;
  // Subscribers whose scan aborted unexpectedly (their last_run_at is NOT advanced).
  failed: number;
  // True when the run stopped early to stay under the subrequest cap — work remains.
  budgetStopped: boolean;
}

// Sharding + budget tuning. One watched repo costs ~1 search + up to 8 candidate
// snapshots at ~6 subrequests each ≈ 50 GitHub subrequests; a subscriber watches
// up to 15 repos (~750). The Workers per-invocation subrequest cap is 1000, so we
// process a bounded, least-recently-scanned batch and stop before exhausting it.
const EST_SUBREQUESTS_PER_REPO = 50;
const TOKEN_PROBE_SUBREQUESTS = 1; // the /user token-validity check
const SUBREQUEST_BUDGET = 800; // headroom under the 1000 cap for sibling cron tasks
// Upper bound on subscribers pulled from D1 per run; the budget guard is the real
// limiter — this just caps the query.
const MAX_SUBS_PER_RUN = 50;

type Outcome = 'scanned' | 'aborted' | 'deactivated';

// Daily re-scan: for a bounded batch of subscribers (least-recently-scanned
// first), re-run clone detection over their watched repos, diff against the known
// baseline, and email only the NEW ones. Returns a summary so the caller can log
// an aborted/budget-bound run distinctly from a clean one.
export async function runImpersonationScan(env: Env, now: number): Promise<ScanRunResult> {
  const result: ScanRunResult = { scanned: 0, deactivated: 0, failed: 0, budgetStopped: false };

  let subscriptions: Subscription[];
  try {
    subscriptions = await listActiveSubscriptions(env, MAX_SUBS_PER_RUN);
  } catch (err) {
    console.log(`[cron] could not load subscriptions: ${String(err)}`);
    result.failed = 1;
    return result;
  }

  let consumed = 0;
  for (const sub of subscriptions) {
    const watched = await getWatchedRepos(env, sub.login);

    // Budget guard: stop gracefully before this subscriber would push the run
    // over the cap. Always let the first subscriber run so we make forward
    // progress even when its estimate alone is large.
    const estimate = TOKEN_PROBE_SUBREQUESTS + watched.length * EST_SUBREQUESTS_PER_REPO;
    if (consumed > 0 && consumed + estimate > SUBREQUEST_BUDGET) {
      result.budgetStopped = true;
      break;
    }
    consumed += estimate;

    const outcome = await scanSubscriber(env, sub, watched, now);
    if (outcome === 'deactivated') {
      result.deactivated++;
      // active = 0 now; it leaves the scan set, so no cursor update is needed.
    } else if (outcome === 'scanned') {
      result.scanned++;
      await setLastRun(env, sub.login, now); // clean-run marker
      await setLastScanned(env, sub.login, now); // rotate the sharding cursor
    } else {
      result.failed++;
      // Advance the cursor (so a stuck subscriber can't starve the rest) but NOT
      // last_run_at — the stale marker is how an abort is surfaced.
      await setLastScanned(env, sub.login, now);
    }
  }

  return result;
}

async function scanSubscriber(
  env: Env,
  sub: Subscription,
  watched: string[],
  now: number,
): Promise<Outcome> {
  let token: string | null;
  try {
    token = await decrypt(sub.tokenEnc, env.SESSION_SECRET);
  } catch (err) {
    console.log(`[cron] token decrypt failed for ${sub.login}: ${String(err)}`);
    return 'aborted';
  }
  if (!token) {
    // Unusable token (scheme/version mismatch) — can't authenticate and won't
    // self-heal. Deactivate rather than retry forever.
    console.log(`[cron] deactivating ${sub.login}: stored token is unusable`);
    await deactivateSubscription(env, sub.login);
    return 'deactivated';
  }

  const client = new GitHubClient(token);

  // Validate the token up front. Clone search swallows auth errors (it returns no
  // matches on failure), so without this probe a revoked grant would retry daily
  // forever. A 401 here means the OAuth grant is gone — deactivate it.
  try {
    await client.getAuthenticatedUser();
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.log(`[cron] deactivating ${sub.login}: GitHub returned 401 (token revoked)`);
      await deactivateSubscription(env, sub.login);
      return 'deactivated';
    }
    console.log(`[cron] auth probe failed for ${sub.login}: ${String(err)}`);
    return 'aborted';
  }

  if (watched.length === 0) return 'scanned'; // nothing to scan is a clean run

  // We only need the source repos' name/owner; description/stars are looked up
  // implicitly by the search. Derive the owner from the full_name.
  const sources = watched.map((fullName) => ({
    owner: fullName.split('/')[0] ?? sub.login,
    fullName,
    description: null,
    stargazers: 0,
  }));

  let matches: CloneMatch[];
  try {
    matches = await findClonesForRepos(client, sources, { now });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.log(`[cron] deactivating ${sub.login}: GitHub returned 401 during scan`);
      await deactivateSubscription(env, sub.login);
      return 'deactivated';
    }
    console.log(`[cron] scan failed for ${sub.login}: ${String(err)}`);
    return 'aborted';
  }

  const known = await getKnownSuspectRepos(env, sub.login);
  const fresh = dedupeBySuspect(matches).filter((m) => !known.has(m.suspectRepo.toLowerCase()));

  if (fresh.length > 0) {
    // Persist the dedupe baseline BEFORE sending the email. Any DB failure thus
    // happens here, before an email goes out, so the next run simply retries; and
    // there is no DB write AFTER the send that could throw and re-trigger a
    // duplicate alert. The send is the final, side-effect-only step.
    try {
      const unsubscribeToken = await rotateUnsubscribeToken(env, sub.login);
      await recordClones(
        env,
        sub.login,
        fresh.map((m) => ({
          sourceRepo: m.sourceRepo,
          suspectRepo: m.suspectRepo,
          confidence: m.confidence,
          firstSeen: now,
          notified: true,
        })),
      );

      const { sent } = await sendImpersonationAlert(env, {
        to: sub.email,
        login: sub.login,
        matches: fresh,
        unsubscribeToken,
      });
      if (!sent) {
        console.log(`[cron] alert email failed for ${sub.login} (${fresh.length} new clone(s))`);
      }
    } catch (err) {
      // Baseline write failed before any email — retried next run.
      console.log(`[cron] could not record/alert clones for ${sub.login}: ${String(err)}`);
      return 'aborted';
    }
  }

  return 'scanned';
}

function dedupeBySuspect(matches: CloneMatch[]): CloneMatch[] {
  const seen = new Set<string>();
  const out: CloneMatch[] = [];
  for (const m of matches) {
    const key = m.suspectRepo.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}
