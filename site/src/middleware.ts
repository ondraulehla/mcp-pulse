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

export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
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
    const cached = edge ? await edge.match(request) : undefined;
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
  if (edge) {
    const copy = new Response(body.slice(0), { status: response.status, headers });
    try {
      const ctx = (context.locals as { runtime?: { ctx?: { waitUntil(p: Promise<unknown>): void } } }).runtime?.ctx;
      const put = edge.put(request, copy);
      ctx ? ctx.waitUntil(put.catch(() => undefined)) : await put.catch(() => undefined);
    } catch {
      /* no edge cache here */
    }
  }
  return new Response(body, { status: response.status, headers: [...headers, ['x-cache', 'miss']] });
});
