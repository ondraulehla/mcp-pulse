import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';

/**
 * Caches rendered GET responses inside the isolate. The data changes once a day,
 * and a front-page spike hits a handful of URLs, so this keeps D1 reads flat.
 * The Cache API is tried as well; it helps on a custom domain and is harmless on workers.dev.
 */
const memory = new Map<string, { expires: number; status: number; headers: [string, string][]; body: ArrayBuffer }>();
const MAX_ENTRIES = 400;

function withCharset(type: string | null): string {
  const t = type ?? 'text/html';
  return /charset=/i.test(t) || !/^(text\/|image\/svg)/.test(t) ? t : `${t}; charset=utf-8`;
}

/** What the browser may keep: a minute for pages, an hour for badges and sitemaps. The zone's own TTL must not leak through. */
function browserCacheControl(contentType: string | null): string {
  return /svg|xml/i.test(contentType ?? '') ? 'public, max-age=3600, must-revalidate' : 'public, max-age=60, must-revalidate';
}

function ttlOf(response: Response): number {
  const cc = response.headers.get('cache-control') ?? '';
  const m = /s-maxage=(\d+)/.exec(cc) ?? /max-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) : 0;
}

const CANONICAL_HOST = 'mcp-pulse.ulehla.dev';

/** Seconds until the next midnight UTC, when the D1 free tier counters reset. */
function secondsToMidnightUtc(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function limitResponse(url: URL, message: string): Response {
  const retry = secondsToMidnightUtc();
  const headers = { 'cache-control': 'no-store', 'retry-after': String(retry) };
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
    return Response.json({ error: 'The database read budget for today is spent. The board is back at 00:00 UTC.', retryAfterSeconds: retry, detail: message.slice(0, 160) }, { status: 503, headers });
  }
  const minutes = Math.round(retry / 60);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Back at 00:00 UTC · mcp-pulse</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120f0c;color:#eee7d8;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;padding:32px}h1{font-size:1.4rem;margin:0 0 12px}p{margin:8px 0;color:#b8ae9c}a{color:#e8571f}code{color:#eee7d8}</style></head>
<body><main><h1>The board is resting until 00:00 UTC</h1><p>The free database tier allows a fixed number of row reads a day, and today's budget is spent. Pages are back in about ${minutes} minutes.</p><p>Until then: <a href="https://www.npmjs.com/package/mcptop">npx mcptop</a> measures the servers in your own config, and the <a href="https://github.com/ondraulehla/mcp-pulse">repository</a> has the method and the data.</p></main></body></html>`;
  return new Response(html, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}

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
  if (request.method !== 'GET' || import.meta.env.DEV) return next();
  // The deployed version is part of the key, so a deploy never serves stale pages.
  const version = (env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA?.id ?? 'dev';
  const key = `${request.url}${url.search ? '&' : '?'}__v=${version}`;
  const now = Date.now();

  const hit = memory.get(key);
  if (hit && hit.expires > now) {
    const h = new Headers(hit.headers);
    h.set('cache-control', browserCacheControl(h.get('content-type')));
    h.set('x-cache', 'memory');
    return new Response(hit.body.slice(0), { status: hit.status, headers: h });
  }

  let edge: Cache | undefined;
  try {
    edge = (caches as unknown as { default?: Cache }).default;
    const cached = edge ? await edge.match(new Request(key, { method: 'GET' })) : undefined;
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('cache-control', browserCacheControl(h.get('content-type')));
      h.set('x-cache', 'edge');
      return new Response(cached.body, { status: cached.status, headers: h });
    }
  } catch {
    edge = undefined;
  }

  let response: Response;
  try {
    response = await next();
  } catch (err) {
    // D1 on the free tier stops answering when the day's row budget is spent. Say so instead of a blank 500.
    const message = err instanceof Error ? err.message : String(err);
    if (/daily row (read|write) limit|D1_/i.test(message)) return limitResponse(url, message);
    throw err;
  }
  const ttl = ttlOf(response);
  if (response.status !== 200 || ttl <= 0) {
    if (response.headers.has('cache-control') && response.status === 200) {
      const h = new Headers(response.headers);
      h.set('cache-control', browserCacheControl(h.get('content-type')));
      return new Response(response.body, { status: response.status, headers: h });
    }
    return response;
  }

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
      headers: { 'content-type': withCharset(response.headers.get('content-type')), 'cache-control': `public, max-age=${ttl}` }
    });
    try {
      await edge.put(new Request(key, { method: 'GET' }), copy);
      edgeNote = 'stored';
    } catch (err) {
      edgeNote = `put-failed: ${(err as Error).message}`.slice(0, 80);
    }
  }
  const out = new Headers(headers);
  out.set('cache-control', browserCacheControl(out.get('content-type')));
  out.set('x-cache', 'miss');
  out.set('x-edge', edgeNote);
  return new Response(body, { status: response.status, headers: out });
});
