// Small Web Crypto helpers. Used to encrypt GitHub access tokens at rest in D1
// (AES-GCM) and to sign short-lived OAuth `state` values (HMAC).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] as string);
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return fromBase64(b64 + pad);
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64(buf).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] as string);
}

// SHA-256 of a string as lowercase hex. Used to store session ids HASHED at rest
// so a database read can't replay them as bearer cookies — the raw id lives only
// in the cookie; D1 holds only its hash.
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Derived AES/HMAC keys are only as strong as SESSION_SECRET. Fail closed at the
// derivation point rather than silently keying off a weak secret.
const MIN_SECRET_LENGTH = 32;

function assertSecretStrength(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

// At-rest ciphertext format version. Bump when the encryption scheme changes;
// decrypt refuses other versions so a scheme/format change forces re-auth instead
// of silently mis-decrypting old blobs.
const CIPHER_VERSION = 'v1';

async function aesKey(secret: string): Promise<CryptoKey> {
  assertSecretStrength(secret);
  // Domain-separated from the HMAC key so the same SESSION_SECRET never serves
  // two cryptographic purposes with the same derived key material.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:aes-gcm:v1`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Returns "<version>:iv.ciphertext", iv and ciphertext base64.
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `${CIPHER_VERSION}:${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

// Returns the plaintext, or null when the blob carries an unknown/absent version
// marker (a different scheme — caller should treat it as "needs re-auth"). Throws
// only when a current-version blob is structurally malformed or fails auth.
export async function decrypt(payload: string, secret: string): Promise<string | null> {
  const sep = payload.indexOf(':');
  if (sep < 0 || payload.slice(0, sep) !== CIPHER_VERSION) return null;
  const [ivB64, ctB64] = payload.slice(sep + 1).split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed ciphertext');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivB64) },
    key,
    fromBase64(ctB64),
  );
  return decoder.decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  assertSecretStrength(secret);
  // Domain-separated from the AES key (see aesKey).
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:hmac:v1`));
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// Sign a value, returning "value.signature". Used for the OAuth state cookie.
export async function sign(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return `${value}.${toBase64(new Uint8Array(sig))}`;
}

export async function verify(signed: string, secret: string): Promise<string | null> {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sigB64 = signed.slice(idx + 1);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    // fromBase64 throws on non-base64 input; decode before the verify call so a
    // malformed signature is a verification failure, not an uncaught 500.
    sig = fromBase64(sigB64);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    encoder.encode(value),
  ).catch(() => false);
  return ok ? value : null;
}

// URL-safe, stateless HMAC capability token: "base64url(value).base64url(sig)".
// Unlike `sign` (which lands in a cookie), this is safe to drop straight into a
// link. It carries NO stored state — the value is recovered and the signature
// re-verified on demand — so a capability link (e.g. unsubscribe) stays valid
// indefinitely and a database read reveals nothing replayable.
export async function signToken(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const data = encoder.encode(value);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `${toBase64Url(data)}.${toBase64Url(new Uint8Array(sig))}`;
}

// Returns the signed value if the signature is valid, else null (tampered,
// malformed, or wrong secret). Constant-time via crypto.subtle.verify.
export async function verifyToken(token: string, secret: string): Promise<string | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  let data: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    data = fromBase64Url(token.slice(0, dot));
    sig = fromBase64Url(token.slice(dot + 1));
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sig, data).catch(() => false);
  return ok ? decoder.decode(data) : null;
}
