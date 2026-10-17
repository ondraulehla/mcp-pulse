import type { APIRoute } from 'astro';
import { listTracked } from '../../lib/track';

/** Servers tracked on request, outside the official registry. The daily probe reads this list. */
export const GET: APIRoute = async () => {
  const rows = await listTracked();
  return Response.json(
    { tracked: rows.map((r) => ({ name: r.name, url: r.url, transport: r.transport, submittedAt: r.submitted_at })), source: 'https://mcpcost.ulehla.dev/check' },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=1800', 'access-control-allow-origin': '*' } }
  );
};
