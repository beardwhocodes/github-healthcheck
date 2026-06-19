import type { Env } from '../env.js';
import type { CloneMatch } from '../engine/types.js';

const FROM_NAME = 'GitHub Healthcheck';

function verifyUrl(appUrl: string, token: string): string {
  return `${appUrl}/email/verify?token=${encodeURIComponent(token)}`;
}

function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Headers that let mail clients show a native one-click unsubscribe.
function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function send(
  env: Env,
  args: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> },
): Promise<{ sent: boolean }> {
  try {
    await env.EMAIL.send({
      to: args.to,
      from: { email: env.ALERT_FROM_EMAIL, name: FROM_NAME },
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: args.headers,
    });
    return { sent: true };
  } catch (err) {
    console.log(`[email] send failed to ${args.to.replace(/(.).*(@.*)/, '$1***$2')}: ${String(err)}`);
    return { sent: false };
  }
}

// Double opt-in: sent on subscribe. Confirms ownership before any alert fires.
export async function sendVerificationEmail(
  env: Env,
  args: { to: string; login: string; verifyToken: string; unsubscribeToken: string },
): Promise<{ sent: boolean }> {
  const verify = verifyUrl(env.APP_URL, args.verifyToken);
  const unsub = unsubscribeUrl(env.APP_URL, args.unsubscribeToken);
  const subject = 'Confirm your GitHub Healthcheck alerts';

  const text = [
    `Hi ${args.login},`,
    '',
    'Confirm this address to turn on alerts that notify you when a new malicious',
    'clone of one of your GitHub repositories appears.',
    '',
    `Confirm: ${verify}`,
    '',
    "If you didn't request this, ignore this email or unsubscribe:",
    unsub,
  ].join('\n');

  const html = shell(
    `<p>Hi ${escapeHtml(args.login)},</p>
     <p>Confirm this address to turn on alerts that notify you when a new malicious
     clone of one of your GitHub repositories appears.</p>
     ${button(verify, 'Confirm my email')}
     <p style="color:#6b7895;font-size:13px;margin-top:18px">If you didn't request this, you can ignore this email or
     <a href="${escapeHtml(unsub)}" style="color:#9aa6c0">unsubscribe</a>.</p>`,
  );

  return send(env, { to: args.to, subject, html, text, headers: unsubscribeHeaders(unsub) });
}

// Sent by the daily cron when NEW suspected clones appear.
export async function sendImpersonationAlert(
  env: Env,
  args: { to: string; login: string; matches: CloneMatch[]; unsubscribeToken: string },
): Promise<{ sent: boolean }> {
  const unsub = unsubscribeUrl(env.APP_URL, args.unsubscribeToken);
  const n = args.matches.length;
  const subject = `GitHub Healthcheck: ${n} new possible clone${n === 1 ? '' : 's'} of your repositories`;

  const text = [
    `Hi ${args.login},`,
    '',
    `We found ${n} new repositor${n === 1 ? 'y' : 'ies'} that may be malicious clones of your work:`,
    '',
    ...args.matches.flatMap((m) => [
      `• ${m.suspectRepo} (copy of ${m.sourceRepo}) — confidence ${m.confidence}/100, risk ${m.report.score}/100`,
      `  ${m.suspectUrl}`,
      ...(m.matchReasons.length ? [`  Why: ${m.matchReasons.join('; ')}`] : []),
    ]),
    '',
    `Review them: ${env.APP_URL}`,
    'Report confirmed impersonations at github.com/contact/report-abuse.',
    '',
    `Unsubscribe from these alerts: ${unsub}`,
  ].join('\n');

  const rows = args.matches
    .map(
      (m) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #243049">
          <a href="${escapeHtml(m.suspectUrl)}" style="color:#4f8cff;font-weight:600">${escapeHtml(m.suspectRepo)}</a><br/>
          <span style="color:#9aa6c0;font-size:13px">copy of ${escapeHtml(m.sourceRepo)}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #243049;text-align:right">
          <span style="color:#f97316;font-weight:600">risk ${m.report.score}</span><br/>
          <span style="color:#9aa6c0;font-size:13px">confidence ${m.confidence}</span>
        </td>
      </tr>`,
    )
    .join('');

  const html = shell(
    `<p>Hi ${escapeHtml(args.login)},</p>
     <p>We found <strong>${n}</strong> new repositor${n === 1 ? 'y' : 'ies'} that may be malicious clones of your work.</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">${rows}</table>
     ${button(env.APP_URL, 'Review in GitHub Healthcheck')}
     <p style="color:#6b7895;font-size:13px;margin-top:16px">Report confirmed impersonations at github.com/contact/report-abuse ·
     <a href="${escapeHtml(unsub)}" style="color:#9aa6c0">unsubscribe</a></p>`,
  );

  return send(env, { to: args.to, subject, html, text, headers: unsubscribeHeaders(unsub) });
}

// Sent when an admin replies to a support-inbox message.
export async function sendContactReply(
  env: Env,
  args: { to: string; login: string; subject: string; reply: string },
): Promise<{ sent: boolean }> {
  const subject = `Re: ${args.subject}`;
  const text = [
    `Hi ${args.login},`,
    '',
    args.reply,
    '',
    '—',
    'GitHub Healthcheck support',
    env.APP_URL,
  ].join('\n');

  const html = shell(
    `<p>Hi ${escapeHtml(args.login)},</p>
     <p style="white-space:pre-wrap">${escapeHtml(args.reply)}</p>
     <p style="color:#6b7895;font-size:13px;margin-top:18px">— GitHub Healthcheck support ·
     <a href="${escapeHtml(env.APP_URL)}" style="color:#9aa6c0">${escapeHtml(env.APP_URL)}</a></p>`,
  );

  return send(env, { to: args.to, subject, html, text });
}

// Sent to the admin (if ADMIN_EMAIL is configured) when a new support message
// arrives, so they don't have to poll the dashboard.
export async function sendAdminContactNotice(
  env: Env,
  args: { from: string; subject: string; body: string },
): Promise<{ sent: boolean }> {
  if (!env.ADMIN_EMAIL) return { sent: false };
  const subject = `[Healthcheck support] ${args.subject}`;
  const text = [
    `New support message from ${args.from}:`,
    '',
    `Subject: ${args.subject}`,
    '',
    args.body,
    '',
    `Manage: ${env.APP_URL}`,
  ].join('\n');

  const html = shell(
    `<p><strong>New support message</strong> from ${escapeHtml(args.from)}.</p>
     <p style="color:#9aa6c0;font-size:13px">Subject: ${escapeHtml(args.subject)}</p>
     <p style="white-space:pre-wrap">${escapeHtml(args.body)}</p>
     ${button(`${env.APP_URL}`, 'Open the dashboard')}`,
  );

  return send(env, { to: env.ADMIN_EMAIL, subject, html, text });
}

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0b1020;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#151d36;border:1px solid #243049;border-radius:12px;overflow:hidden">
      <div style="background:#0f172a;color:#fff;padding:16px 20px;font-weight:700">🛡️ GitHub Healthcheck</div>
      <div style="padding:20px;color:#e6ebf5;font-size:15px;line-height:1.5">${inner}</div>
    </div>
  </body></html>`;
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#4f8cff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
