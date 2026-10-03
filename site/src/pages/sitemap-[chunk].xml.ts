import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { latestRun } from '../lib/db';
import { CHUNK } from './sitemap.xml';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One chunk of server pages, or the handful of static pages for "pages". */
export const GET: APIRoute = async ({ params, site }) => {
  const base = (site ?? new URL('https://mcp-pulse.ulehla.dev')).toString().replace(/\/$/, '');
  const headers = { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' };
  const run = await latestRun();
  const lastmod = run?.probedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  let entries: Array<{ loc: string; lastmod: string }>;
  if (params.chunk === 'pages') {
    entries = ['/', '/tokens', '/servers', '/statistics', '/hosts', '/check', '/methodology'].map((p) => ({ loc: `${base}${p}`, lastmod }));
  } else {
    const n = Number(params.chunk);
    if (!Number.isInteger(n) || n < 1 || n > 100) return new Response('Not found', { status: 404 });
    const db = (env as unknown as { DB: D1Database }).DB;
    const { results } = await db
      .prepare('SELECT name, probed_at FROM servers ORDER BY name LIMIT ? OFFSET ?')
      .bind(CHUNK, (n - 1) * CHUNK)
      .all<{ name: string; probed_at: string }>();
    if (!results.length) return new Response('Not found', { status: 404 });
    entries = results.map((r) => ({ loc: `${base}/s/${r.name}`, lastmod: r.probed_at.slice(0, 10) }));
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `  <url><loc>${escape(e.loc)}</loc><lastmod>${e.lastmod}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers });
};
