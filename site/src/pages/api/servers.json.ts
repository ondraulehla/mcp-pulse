import type { APIRoute } from 'astro';
import { listServers, SORTS, DEFAULT_SORT, MAX_NUMBERED_PAGE, decodeCursor, encodeCursor, type SortKey } from '../../lib/db';

/**
 * A page of servers with the same filters as /servers: q, status, host, protocol,
 * transport, sort, page. Page numbers go to 20; after that pass the `next`
 * cursor from the previous answer as `cursor`.
 */
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const sort = (Object.keys(SORTS).includes(p.get('sort') ?? '') ? p.get('sort') : DEFAULT_SORT) as SortKey;
  const cursor = decodeCursor(p.get('cursor'));
  const { rows, hasNext, hasPrev, page, perPage, nextCursor, prevCursor } = await listServers({
    cursor,
    back: p.get('direction') === 'prev',
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
    { page: cursor ? undefined : page, perPage, hasNext, hasPrev, next: hasNext && nextCursor ? encodeCursor(nextCursor) : null, prev: hasPrev && prevCursor ? encodeCursor(prevCursor) : null, cursorNote: 'pass next as ?cursor=; pass prev as ?cursor=&direction=prev', maxNumberedPage: MAX_NUMBERED_PAGE, fields: { claude_tokens: 'exact, Anthropic count_tokens, names as published', claude_tokens_cc: 'exact, with the Claude Code mcp__<server>__ prefix', tools_tokens: 'estimate, o200k_base over compact JSON' }, servers: rows },
    { headers: { 'cache-control': 'public, max-age=120, s-maxage=10800', 'access-control-allow-origin': '*' } }
  );
};
