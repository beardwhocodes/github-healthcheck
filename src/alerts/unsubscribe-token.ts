import { signToken, verifyToken } from '../auth/crypto.js';
import type { Env } from '../env.js';

// Stateless, signed unsubscribe capability. The token is an HMAC over the
// subscriber's login (domain-separated by a prefix so a signature minted here
// can't be replayed in another context). It is NOT stored: it is recomputed
// when an email is built and re-verified when the link is clicked. That means
// every email's unsubscribe link stays valid indefinitely (no per-send rotation
// breaking older emails) and a database read yields nothing replayable.
const PREFIX = 'unsub:';

export function makeUnsubscribeToken(env: Env, login: string): Promise<string> {
  return signToken(PREFIX + login, env.SESSION_SECRET);
}

// Returns the login the token authorizes unsubscribing, or null if the token is
// missing, malformed, tampered, or signed for a different purpose.
export async function readUnsubscribeToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  const value = await verifyToken(token, env.SESSION_SECRET);
  return value && value.startsWith(PREFIX) ? value.slice(PREFIX.length) : null;
}
