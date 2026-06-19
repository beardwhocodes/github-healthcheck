import type { Env } from '../env.js';
import type { CloneMatch } from '../engine/types.js';

// Send an impersonation alert. Uses Resend when RESEND_API_KEY is configured;
// otherwise logs the alert (so local/dev runs work without an email provider).
export async function sendImpersonationAlert(
  env: Env,
  args: { to: string; login: string; matches: CloneMatch[] },
): Promise<{ sent: boolean }> {
  const subject = `RepoSentry: ${args.matches.length} new possible clone${
    args.matches.length === 1 ? '' : 's'
  } of your repositories`;
  const html = renderAlertHtml(args.login, args.matches, env.APP_URL);
  const text = renderAlertText(args.login, args.matches, env.APP_URL);

  if (!env.RESEND_API_KEY) {
    console.log(`[alert] ${args.to}: ${subject}\n${text}`);
    return { sent: false };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `RepoSentry <${env.ALERT_FROM_EMAIL}>`,
      to: [args.to],
      subject,
      html,
      text,
    }),
  });

  return { sent: resp.ok };
}

function renderAlertText(login: string, matches: CloneMatch[], appUrl: string): string {
  const lines = [
    `Hi ${login},`,
    '',
    `RepoSentry found ${matches.length} new repositor${matches.length === 1 ? 'y' : 'ies'} that may be malicious clones of your work:`,
    '',
  ];
  for (const m of matches) {
    lines.push(
      `• ${m.suspectRepo} (copy of ${m.sourceRepo}) — confidence ${m.confidence}/100, risk ${m.report.score}/100`,
    );
    lines.push(`  ${m.suspectUrl}`);
    if (m.matchReasons.length) lines.push(`  Why: ${m.matchReasons.join('; ')}`);
  }
  lines.push('', `Review them: ${appUrl}`, '', 'You can report confirmed impersonations to GitHub at github.com/contact/report-abuse.');
  return lines.join('\n');
}

function renderAlertHtml(login: string, matches: CloneMatch[], appUrl: string): string {
  const rows = matches
    .map(
      (m) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">
          <a href="${escapeHtml(m.suspectUrl)}" style="color:#2563eb;font-weight:600">${escapeHtml(m.suspectRepo)}</a><br/>
          <span style="color:#666;font-size:13px">copy of ${escapeHtml(m.sourceRepo)}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">
          <span style="color:#b91c1c;font-weight:600">risk ${m.report.score}</span><br/>
          <span style="color:#666;font-size:13px">confidence ${m.confidence}</span>
        </td>
      </tr>`,
    )
    .join('');

  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;background:#f8fafc;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <div style="background:#0f172a;color:#fff;padding:16px 20px;font-weight:700">RepoSentry alert</div>
      <div style="padding:20px">
        <p>Hi ${escapeHtml(login)},</p>
        <p>We found <strong>${matches.length}</strong> new repositor${matches.length === 1 ? 'y' : 'ies'} that may be malicious clones of your work.</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">${rows}</table>
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Review in RepoSentry</a>
        <p style="color:#666;font-size:13px;margin-top:16px">Report confirmed impersonations at github.com/contact/report-abuse.</p>
      </div>
    </div>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
