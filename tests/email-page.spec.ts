import { describe, expect, it } from 'vitest';

import { html, page } from '../src/routes/email.js';

describe('html tagged template', () => {
  it('escapes interpolated < and > characters', () => {
    const result = html`x ${'<script>alert(1)</script>'} y`;
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('keeps static markup verbatim while escaping dynamic values', () => {
    const result = html`<strong>${'a&b'}</strong>`;
    expect(result).toContain('<strong>');
    expect(result).toContain('</strong>');
    expect(result).toContain('a&amp;b');
    expect(result).not.toContain('a&b');
  });

  it('escapes double-quote characters in interpolated values', () => {
    const result = html`<a href="${'"evil"'}"`;
    expect(result).toContain('&quot;evil&quot;');
    expect(result).not.toContain('"evil"');
  });

  it('passes through a template with no interpolations unchanged', () => {
    const result = html`Hello, world!`;
    expect(result).toBe('Hello, world!');
  });
});

describe('page() with html-tagged body', () => {
  const appUrl = 'https://example.com';

  it('renders a verify page without unescaped < in a malicious email address', () => {
    const maliciousEmail = 'x"><img src=x onerror=alert(1)>@e.com';
    const rendered = page(
      'Email confirmed ✓',
      html`Alerts are now active for <strong>${maliciousEmail}</strong>.`,
      appUrl,
    );
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
  });

  it('preserves intentional <strong> markup in the body', () => {
    const rendered = page(
      'Test',
      html`Hello <strong>${'world'}</strong>`,
      appUrl,
    );
    expect(rendered).toContain('<strong>world</strong>');
  });

  it('escapes the title to prevent injection via page heading', () => {
    const rendered = page(
      '<script>bad</script>',
      html`Body text`,
      appUrl,
    );
    expect(rendered).not.toContain('<script>bad</script>');
    expect(rendered).toContain('&lt;script&gt;bad&lt;/script&gt;');
  });
});
