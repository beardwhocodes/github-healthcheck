import { decrypt } from '../auth/crypto.js';
import type { Env } from '../env.js';
import type { CloneMatch } from '../engine/types.js';
import { findClonesForRepos } from '../github/clone-detection.js';
import { GitHubClient } from '../github/client.js';
import {
  getKnownSuspectRepos,
  getWatchedRepos,
  listActiveSubscriptions,
  recordClones,
  setLastRun,
} from './store.js';
import { sendImpersonationAlert } from './email.js';

// Daily re-scan: for each active subscriber, re-run clone detection over their
// watched repos, diff against the known baseline, and email only the NEW ones.
export async function runImpersonationScan(env: Env, now: number): Promise<void> {
  let subscriptions;
  try {
    subscriptions = await listActiveSubscriptions(env);
  } catch (err) {
    console.log(`[cron] could not load subscriptions: ${String(err)}`);
    return;
  }

  for (const sub of subscriptions) {
    try {
      const token = await decrypt(sub.tokenEnc, env.SESSION_SECRET);
      const client = new GitHubClient(token);

      const watched = await getWatchedRepos(env, sub.login);
      if (watched.length === 0) {
        await setLastRun(env, sub.login, now);
        continue;
      }

      // We only need the source repos' name/owner; description/stars are looked
      // up implicitly by the search. Use the full_name to derive owner.
      const sources = watched.map((fullName) => ({
        owner: fullName.split('/')[0] ?? sub.login,
        fullName,
        description: null,
        stargazers: 0,
      }));

      const matches = await findClonesForRepos(client, sources, { now });
      const known = await getKnownSuspectRepos(env, sub.login);
      const fresh = dedupeBySuspect(matches).filter(
        (m) => !known.has(m.suspectRepo.toLowerCase()),
      );

      if (fresh.length > 0) {
        const { sent } = await sendImpersonationAlert(env, {
          to: sub.email,
          login: sub.login,
          matches: fresh,
        });
        await recordClones(
          env,
          sub.login,
          fresh.map((m) => ({
            sourceRepo: m.sourceRepo,
            suspectRepo: m.suspectRepo,
            confidence: m.confidence,
            firstSeen: now,
            notified: sent,
          })),
        );
      }

      await setLastRun(env, sub.login, now);
    } catch (err) {
      console.log(`[cron] scan failed for ${sub.login}: ${String(err)}`);
    }
  }
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
