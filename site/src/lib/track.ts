/**
 * Servers outside the official registry, tracked on request. The daily probe
 * reads /api/tracked.json and probes them with the registry servers; the name
 * on the board is url/<host>/<path>.
 */
import { env } from 'cloudflare:workers';
import { findByUrl } from './db';

export interface TrackedRecord {
  name: string;
  url: string;
  transport: string;
  submitted_at: string;
}

/** How many servers one client may submit a day. */
const MAX_PER_IP_DAY = 20;

function db(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

/** The board name of a tracked URL: url/<host>/<path>, with the path reduced to safe characters. */
export function trackedName(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '').replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\/+/g, '/');
  return `url/${url.hostname.toLowerCase()}${path}`;
}

export type TrackResult =
  | { ok: true; name: string; existed: boolean; inRegistry: boolean }
  | { ok: false; reason: string };

/** Validates the URL the way /check does. */
export function parseTrackable(raw: string): URL | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { reason: 'That is not a URL.' };
  }
  if (url.protocol !== 'https:') return { reason: 'Only https URLs are tracked.' };
  if (!url.hostname.includes('.') || /^(\d+\.){3}\d+$/.test(url.hostname) || url.hostname.endsWith('.local')) return { reason: 'That host is not reachable from here.' };
  url.hash = '';
  return url;
}

/**
 * Records a URL for the daily probe. The caller has probed it already and
 * passes the result, so a URL that does not answer is not tracked.
 */
export async function createTracked(url: URL, status: string, ipHash: string): Promise<TrackResult> {
  const known = await findByUrl(url.toString());
  if (known) return { ok: true, name: known, existed: true, inRegistry: true };
  const name = trackedName(url);
  const d = db();
  const existing = await d.prepare('SELECT name FROM tracked WHERE name = ? OR url = ?').bind(name, url.toString()).first<{ name: string }>();
  if (existing) return { ok: true, name: existing.name, existed: true, inRegistry: false };
  if (!['ok', 'auth', 'payment', 'newer_protocol', 'rate_limited'].includes(status)) return { ok: false, reason: 'The server did not answer the probe, so there is nothing to track yet. Bring it up and check again.' };
  const perIp = await d.prepare("SELECT count(*) AS n FROM tracked WHERE ip_hash = ? AND submitted_at > datetime('now', '-1 day')").bind(ipHash).first<{ n: number }>();
  if ((perIp?.n ?? 0) >= MAX_PER_IP_DAY) return { ok: false, reason: 'Too many new servers from here today. Try again tomorrow.' };
  const transport = /\/sse\/?$/.test(url.pathname) ? 'sse' : 'streamable-http';
  await d.prepare('INSERT INTO tracked (name, url, transport, submitted_at, ip_hash) VALUES (?, ?, ?, ?, ?)').bind(name, url.toString(), transport, new Date().toISOString(), ipHash).run();
  return { ok: true, name, existed: false, inRegistry: false };
}

export async function listTracked(): Promise<TrackedRecord[]> {
  const { results } = await db().prepare('SELECT name, url, transport, submitted_at FROM tracked ORDER BY submitted_at').all<TrackedRecord>();
  return results;
}
