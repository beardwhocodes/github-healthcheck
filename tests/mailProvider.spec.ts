import { describe, expect, it } from 'vitest';

import { mailProviderFor } from '../web/src/mailProvider.js';

describe('mailProviderFor', () => {
  it('maps Gmail to a pre-filtered search deep link', () => {
    const p = mailProviderFor('you@gmail.com');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Gmail');
    expect(p!.search).toBe(true);
    expect(p!.url).toContain('mail.google.com');
    expect(p!.url).toContain('#search/');
    expect(p!.url).toContain('from%3Anoreply%40github-healthcheck.beardwho.codes');
  });

  it('treats googlemail.com as Gmail', () => {
    expect(mailProviderFor('a@googlemail.com')?.name).toBe('Gmail');
  });

  it('maps Outlook-family domains to the Outlook inbox', () => {
    expect(mailProviderFor('a@outlook.com')?.name).toBe('Outlook');
    expect(mailProviderFor('a@hotmail.com')?.name).toBe('Outlook');
    expect(mailProviderFor('a@live.com')?.url).toContain('outlook.live.com');
  });

  it('is case-insensitive on the domain', () => {
    expect(mailProviderFor('A@GMAIL.COM')?.name).toBe('Gmail');
  });

  it('returns null for custom/corporate domains we can\'t guess', () => {
    expect(mailProviderFor('dev@mycompany.io')).toBeNull();
  });

  it('returns null for a malformed address', () => {
    expect(mailProviderFor('not-an-email')).toBeNull();
  });
});
