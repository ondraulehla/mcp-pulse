import type { APIRoute } from 'astro';
import { latestRun, maxServerRowid } from '../lib/db';

export const CHUNK = 5_000;

/** A sitemap index: the static pages plus one chunk per 5 000 rowids of the servers table. */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL('https://mcp-pulse.ulehla.dev')).toString().replace(/\/$/, '');
  const [run, maxRowid] = await Promise.all([latestRun(), maxServerRowid()]);
  const chunks = Math.max(1, Math.ceil(maxRowid / CHUNK));
  const lastmod = run?.probedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const urls = [`${base}/sitemap-pages.xml`, ...Array.from({ length: chunks }, (_, i) => `${base}/sitemap-${i + 1}.xml`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <sitemap><loc>${u}</loc><lastmod>${lastmod}</lastmod></sitemap>`)
    .join('\n')}\n</sitemapindex>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' } });
};
