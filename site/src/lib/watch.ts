/**
 * Alerts: an e-mail when a watched server changes its result, its tool count
 * or its token cost. A watch is created from the server page, confirmed by a
 * link in a mail, and stopped by another link. The cron handler in worker.ts
 * sends the mails after each daily run.
 */
import { env } from 'cloudflare:workers';
import { label, num, tokens } from './format';

export interface WatchRecord {
  id: number;
  email: string;
  server: string;
  token: string;
  created_at: string;
  confirmed_at: string | null;
  stopped_at: string | null;
  /** probed_at of the last probe the watcher was told about. */
  notified_at: string | null;
}

interface ProbeRow {
  probed_at: string;
  status: string;
  tool_count: number | null;
  tools_tokens: number | null;
  claude_tokens: number | null;
}

interface Mail {
  to: string;
  from: { email: string; name: string };
  subject: string;
  text: string;
}

const SITE = 'https://mcpcost.ulehla.dev';
const FROM = { email: 'mcpcost@ulehla.dev', name: 'mcpcost' };
/** How many watches one address may hold, confirmed or not. */
const MAX_PER_EMAIL = 50;
/** How many watches one client may create a day. */
const MAX_PER_IP_DAY = 20;

function db(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

function mailer(): { send(mail: Mail): Promise<unknown> } | undefined {
  return (env as unknown as { EMAIL?: { send(mail: Mail): Promise<unknown> } }).EMAIL;
}

/** A stable, anonymous id for a client within one month. */
export async function hashIp(ip: string | undefined): Promise<string> {
  const data = new TextEncoder().encode(`${ip ?? ''}:${new Date().toISOString().slice(0, 7)}:mcpcost`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validEmail(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

async function sendMail(mail: Omit<Mail, 'from'>): Promise<boolean> {
  const m = mailer();
  if (!m) {
    console.error('EMAIL binding is not set, so no mail was sent');
    return false;
  }
  try {
    await m.send({ ...mail, from: FROM });
    return true;
  } catch (e) {
    console.error(`mail to ${mail.to} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export type CreateResult = { ok: true; token: string; mailed: boolean; already: boolean } | { ok: false; reason: string };

/** Creates a watch and sends the confirmation mail. */
export async function createWatch(email: string, server: string, ipHash: string): Promise<CreateResult> {
  email = email.trim().toLowerCase();
  if (!validEmail(email)) return { ok: false, reason: 'That does not look like an e-mail address.' };
  const row = await db().prepare('SELECT name, probed_at FROM servers WHERE name = ?').bind(server).first<{ name: string; probed_at: string }>();
  if (!row) return { ok: false, reason: 'No server with that name on the board.' };
  const d = db();
  const [perEmail, perIp, existing] = await Promise.all([
    d.prepare('SELECT count(*) AS n FROM watches WHERE email = ? AND stopped_at IS NULL').bind(email).first<{ n: number }>(),
    d.prepare("SELECT count(*) AS n FROM watches WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')").bind(ipHash).first<{ n: number }>(),
    d.prepare('SELECT token, confirmed_at FROM watches WHERE email = ? AND server = ? AND stopped_at IS NULL').bind(email, server).first<{ token: string; confirmed_at: string | null }>()
  ]);
  if ((perEmail?.n ?? 0) >= MAX_PER_EMAIL) return { ok: false, reason: `One address can watch at most ${MAX_PER_EMAIL} servers.` };
  if ((perIp?.n ?? 0) >= MAX_PER_IP_DAY) return { ok: false, reason: 'Too many new watches from here today. Try again tomorrow.' };
  if (existing?.confirmed_at) return { ok: true, token: existing.token, mailed: false, already: true };
  const token = existing?.token ?? crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = new Date().toISOString();
  if (!existing) {
    await d.prepare('INSERT INTO watches (email, server, token, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)').bind(email, server, token, now, ipHash).run();
  }
  const mailed = await sendMail({
    to: email,
    subject: `Confirm: watch ${server} on mcpcost`,
    text: [
      `You asked for an e-mail when ${server} changes: when it stops answering, comes back, or its tool set or token cost changes.`,
      '',
      `Confirm the watch: ${SITE}/watch/confirm?t=${token}`,
      '',
      `If you did not ask for this, ignore this mail. Nothing is sent without the confirmation.`,
      '',
      `Server page: ${SITE}/s/${server}`
    ].join('\n')
  });
  if (!mailed) return { ok: false, reason: 'The confirmation mail could not be sent. Try again later, or use the Atom feed of the server.' };
  return { ok: true, token, mailed, already: false };
}

/** Confirms a watch. The baseline is the server's current state, so only later changes are reported. */
export async function confirmWatch(token: string): Promise<WatchRecord | null> {
  const w = await db().prepare('SELECT * FROM watches WHERE token = ?').bind(token).first<WatchRecord>();
  if (!w) return null;
  if (w.stopped_at) return w;
  if (!w.confirmed_at) {
    const server = await db().prepare('SELECT probed_at FROM servers WHERE name = ?').bind(w.server).first<{ probed_at: string }>();
    const now = new Date().toISOString();
    await db().prepare('UPDATE watches SET confirmed_at = ?, notified_at = ? WHERE id = ?').bind(now, server?.probed_at ?? now, w.id).run();
    w.confirmed_at = now;
  }
  return w;
}

export async function stopWatch(token: string): Promise<WatchRecord | null> {
  const w = await db().prepare('SELECT * FROM watches WHERE token = ?').bind(token).first<WatchRecord>();
  if (!w) return null;
  if (!w.stopped_at) {
    await db().prepare('UPDATE watches SET stopped_at = ? WHERE id = ?').bind(new Date().toISOString(), w.id).run();
  }
  return w;
}

function describe(before: ProbeRow | null, after: ProbeRow): string[] {
  const lines: string[] = [];
  if (!before || before.status !== after.status) lines.push(`Result: ${before ? label(before.status) : 'unknown'} → ${label(after.status)}`);
  if (after.status === 'ok') {
    if (!before || before.tool_count !== after.tool_count) lines.push(`Tools: ${before?.tool_count != null ? num(before.tool_count) : '?'} → ${num(after.tool_count)}`);
    const b = before?.claude_tokens ?? before?.tools_tokens;
    const a = after.claude_tokens ?? after.tools_tokens;
    if (b !== a) lines.push(`Tokens: ${b != null ? tokens(b) : '?'} → ${tokens(a)}${after.claude_tokens == null ? ' (o200k estimate)' : ''}`);
  }
  return lines;
}

/**
 * Sends the mails that are due: every confirmed watch whose server has a probe
 * row newer than the last one it was told about. The probes table keeps a row
 * only when the result, the tool count or the cost changed, so a new row is
 * a change by definition. Idempotent: notified_at moves to the newest row.
 */
export async function notifyDue(limit = 200): Promise<{ sent: number; failed: number }> {
  const d = db();
  const { results } = await d
    .prepare(
      `SELECT w.id, w.email, w.server, w.token, w.notified_at FROM watches w
       WHERE w.confirmed_at IS NOT NULL AND w.stopped_at IS NULL
         AND EXISTS (SELECT 1 FROM probes p WHERE p.name = w.server AND p.probed_at > coalesce(w.notified_at, ''))
       LIMIT ?`
    )
    .bind(limit)
    .all<Pick<WatchRecord, 'id' | 'email' | 'server' | 'token' | 'notified_at'>>();
  let sent = 0;
  let failed = 0;
  for (const w of results) {
    const [before, after] = await Promise.all([
      d.prepare('SELECT probed_at, status, tool_count, tools_tokens, claude_tokens FROM probes WHERE name = ? AND probed_at <= ? ORDER BY probed_at DESC LIMIT 1').bind(w.server, w.notified_at ?? '').first<ProbeRow>(),
      d.prepare('SELECT probed_at, status, tool_count, tools_tokens, claude_tokens FROM probes WHERE name = ? ORDER BY probed_at DESC LIMIT 1').bind(w.server).first<ProbeRow>()
    ]);
    if (!after) continue;
    const lines = describe(before, after);
    if (!lines.length) {
      await d.prepare('UPDATE watches SET notified_at = ? WHERE id = ?').bind(after.probed_at, w.id).run();
      continue;
    }
    const headline = before && before.status !== after.status ? `${w.server} is now ${label(after.status)}` : `${w.server} changed`;
    const ok = await sendMail({
      to: w.email,
      subject: `mcpcost: ${headline}`,
      text: [
        `${w.server}, probed ${after.probed_at.slice(0, 16).replace('T', ' ')} UTC.`,
        '',
        ...lines,
        '',
        `Server page: ${SITE}/s/${w.server}`,
        `Stop these mails: ${SITE}/watch/stop?t=${w.token}`
      ].join('\n')
    });
    if (ok) {
      sent++;
      await d.prepare('UPDATE watches SET notified_at = ? WHERE id = ?').bind(after.probed_at, w.id).run();
    } else failed++;
  }
  return { sent, failed };
}
