// Map an email address to a one-click "open your inbox" link. For Gmail we deep-
// link straight into a search filtered to the verification email; other major
// webmail providers open their inbox (their search URLs aren't reliably
// deep-linkable). Unknown / custom domains return null (we can't guess the
// webmail), and the user just checks their mail normally.

// The address our verification email is sent from (production sender).
const SENDER = 'noreply@github-healthcheck.beardwho.codes';

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

const INBOX: Record<string, MailProvider> = {
  outlook: { name: 'Outlook', url: 'https://outlook.live.com/mail/0/', search: false },
  yahoo: { name: 'Yahoo Mail', url: 'https://mail.yahoo.com/', search: false },
  icloud: { name: 'iCloud Mail', url: 'https://www.icloud.com/mail/', search: false },
  proton: { name: 'Proton Mail', url: 'https://mail.proton.me/u/0/', search: false },
  fastmail: { name: 'Fastmail', url: 'https://www.fastmail.com/mail/', search: false },
  aol: { name: 'AOL Mail', url: 'https://mail.aol.com/', search: false },
  zoho: { name: 'Zoho Mail', url: 'https://mail.zoho.com/', search: false },
  gmx: { name: 'GMX', url: 'https://www.gmx.com/', search: false },
  yandex: { name: 'Yandex Mail', url: 'https://mail.yandex.com/', search: false },
};

// Known consumer domains → provider key.
const DOMAIN_MAP: Record<string, () => MailProvider> = {
  'gmail.com': gmail,
  'googlemail.com': gmail,
  'outlook.com': () => INBOX.outlook!,
  'hotmail.com': () => INBOX.outlook!,
  'live.com': () => INBOX.outlook!,
  'msn.com': () => INBOX.outlook!,
  'yahoo.com': () => INBOX.yahoo!,
  'ymail.com': () => INBOX.yahoo!,
  'rocketmail.com': () => INBOX.yahoo!,
  'icloud.com': () => INBOX.icloud!,
  'me.com': () => INBOX.icloud!,
  'mac.com': () => INBOX.icloud!,
  'proton.me': () => INBOX.proton!,
  'protonmail.com': () => INBOX.proton!,
  'pm.me': () => INBOX.proton!,
  'fastmail.com': () => INBOX.fastmail!,
  'aol.com': () => INBOX.aol!,
  'zoho.com': () => INBOX.zoho!,
  'gmx.com': () => INBOX.gmx!,
  'gmx.net': () => INBOX.gmx!,
  'yandex.com': () => INBOX.yandex!,
  'yandex.ru': () => INBOX.yandex!,
};

export function mailProviderFor(email: string): MailProvider | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  const resolve = DOMAIN_MAP[domain];
  return resolve ? resolve() : null;
}
