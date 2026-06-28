// Map an email address to a one-click "open your inbox" link. For Gmail we deep-
// link straight into a search filtered to the verification email; other major
// webmail providers open their inbox (their search URLs aren't reliably
// deep-linkable). Unknown / custom domains return null (we can't guess the
// webmail), and the user just checks their mail normally.

// This tsconfig sets `types: []` and doesn't pull in `vite/client`, so the env
// shape isn't ambient — declare just the build-time var we read. Vite statically
// replaces `import.meta.env.VITE_*` at build time.
declare global {
  interface ImportMeta {
    readonly env: { readonly VITE_ALERT_FROM_EMAIL?: string };
  }
}

// The address our verification email is sent from (production sender). Keep it in
// agreement with ALERT_FROM_EMAIL in wrangler.jsonc so the Gmail deep-link below
// filters on the address that actually sent the mail. Forkers set the
// VITE_ALERT_FROM_EMAIL build env var or edit the fallback (see the Fork /
// self-host table in README).
const SENDER = import.meta.env.VITE_ALERT_FROM_EMAIL ?? 'noreply@github-healthcheck.beardwho.codes';

export interface MailProvider {
  name: string;
  url: string;
  // True when the link lands on a pre-filtered search for our email.
  search: boolean;
}

// Gmail search deep link, pre-filtered to our sender within the last day.
function gmail(): MailProvider {
  const query = encodeURIComponent(`from:${SENDER} newer_than:1d`);
  return { name: 'Gmail', url: `https://mail.google.com/mail/u/0/#search/${query}`, search: true };
}

// `satisfies` (not an explicit `Record<string, MailProvider>` annotation) keeps
// the literal key set in the inferred type, so `INBOX[key]` for a known key
// resolves to `MailProvider` rather than `MailProvider | undefined`.
const INBOX = {
  outlook: { name: 'Outlook', url: 'https://outlook.live.com/mail/0/', search: false },
  yahoo: { name: 'Yahoo Mail', url: 'https://mail.yahoo.com/', search: false },
  icloud: { name: 'iCloud Mail', url: 'https://www.icloud.com/mail/', search: false },
  proton: { name: 'Proton Mail', url: 'https://mail.proton.me/u/0/', search: false },
  fastmail: { name: 'Fastmail', url: 'https://www.fastmail.com/mail/', search: false },
  aol: { name: 'AOL Mail', url: 'https://mail.aol.com/', search: false },
  zoho: { name: 'Zoho Mail', url: 'https://mail.zoho.com/', search: false },
  gmx: { name: 'GMX', url: 'https://www.gmx.com/', search: false },
  yandex: { name: 'Yandex Mail', url: 'https://mail.yandex.com/', search: false },
} satisfies Record<string, MailProvider>;

// Known consumer domains → an INBOX key, or 'gmail' for the dynamic deep link.
const DOMAIN_MAP: Record<string, keyof typeof INBOX | 'gmail'> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'yahoo.com': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'proton.me': 'proton',
  'protonmail.com': 'proton',
  'pm.me': 'proton',
  'fastmail.com': 'fastmail',
  'aol.com': 'aol',
  'zoho.com': 'zoho',
  'gmx.com': 'gmx',
  'gmx.net': 'gmx',
  'yandex.com': 'yandex',
  'yandex.ru': 'yandex',
};

export function mailProviderFor(email: string): MailProvider | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  const key = DOMAIN_MAP[domain];
  if (!key) return null;
  return key === 'gmail' ? gmail() : INBOX[key];
}
