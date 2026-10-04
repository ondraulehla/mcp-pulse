import type { APIRoute } from 'astro';
import { listServers, SORTS, DEFAULT_SORT, type SortKey } from '../../lib/db';

/** A page of servers with the same filters as /servers: q, status, host, protocol, transport, sort, page. */
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const sort = (Object.keys(SORTS).includes(p.get('sort') ?? '') ? p.get('sort') : DEFAULT_SORT) as SortKey;
  const { rows, hasNext, page, perPage } = await listServers({
    q: (p.get('q') ?? '').trim().slice(0, 80),
    status: p.get('status') ?? '',
    host: p.get('host') ?? '',
    protocol: p.get('protocol') ?? '',
    transport: p.get('transport') ?? '',
    sort,
    page: Number(p.get('page') ?? '1') || 1,
    perPage: Number(p.get('per_page') ?? '50') || 50
  });
  return Response.json(
    { page, perPage, hasNext, fields: { claude_tokens: 'exact, Anthropic count_tokens, names as published', claude_tokens_cc: 'exact, with the Claude Code mcp__<server>__ prefix', tools_tokens: 'estimate, o200k_base over compact JSON' }, servers: rows },
    { headers: { 'cache-control': 'public, max-age=120, s-maxage=1800', 'access-control-allow-origin': '*' } }
  );
};
