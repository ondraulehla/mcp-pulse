import { defineMiddleware } from 'astro:middleware';

/**
 * Caches rendered GET responses inside the isolate. The data changes once a day,
 * and a front-page spike hits a handful of URLs, so this keeps D1 reads flat.
 * The Cache API is tried as well; it helps on a custom domain and is harmless on workers.dev.
 */
const memory = new Map<string, { expires: number; status: number; headers: [string, string][]; body: ArrayBuffer }>();
const MAX_ENTRIES = 400;

function ttlOf(response: Response): number {
  const cc = response.headers.get('cache-control') ?? '';
  const m = /s-maxage=(\d+)/.exec(cc) ?? /max-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) : 0;
}

const CANONICAL_HOST = 'mcp-pulse.ulehla.dev';

export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
  const url = new URL(request.url);
  // The workers.dev address stays as an alias and sends everyone to the real one.
  if (url.hostname.endsWith('.workers.dev')) {
    url.hostname = CANONICAL_HOST;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  if (request.method !== 'GET') return next();
  const key = request.url;
  const now = Date.now();

  const hit = memory.get(key);
  if (hit && hit.expires > now) {
    return new Response(hit.body.slice(0), { status: hit.status, headers: [...hit.headers, ['x-cache', 'memory']] });
  }

  let edge: Cache | undefined;
  try {
    edge = (caches as unknown as { default?: Cache }).default;
    const cached = edge ? await edge.match(new Request(key, { method: 'GET' })) : undefined;
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('x-cache', 'edge');
      return new Response(cached.body, { status: cached.status, headers: h });
    }
  } catch {
    edge = undefined;
  }

  const response = await next();
  const ttl = ttlOf(response);
  if (response.status !== 200 || ttl <= 0) return response;

  const body = await response.arrayBuffer();
  const headers: [string, string][] = [...response.headers.entries()];
  if (memory.size >= MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, { expires: now + ttl * 1000, status: response.status, headers, body });
  let edgeNote = 'none';
  if (edge) {
    // Store a copy with only the headers the cache needs, keyed by the bare URL.
    const copy = new Response(body.slice(0), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8', 'cache-control': `public, max-age=${ttl}` }
    });
    try {
      await edge.put(new Request(key, { method: 'GET' }), copy);
      edgeNote = 'stored';
    } catch (err) {
      edgeNote = `put-failed: ${(err as Error).message}`.slice(0, 80);
    }
  }
  return new Response(body, { status: response.status, headers: [...headers, ['x-cache', 'miss'], ['x-edge', edgeNote]] });
});
