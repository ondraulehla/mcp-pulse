import type { APIRoute } from 'astro';
import { findByUrl } from '../../lib/db';
import { probeRemoteRaw } from '../../../../packages/mcptop/src/core.ts';
import { payloadBytes, BYTES_PER_TOKEN } from '../../../../packages/mcptop/src/payload.ts';
import { liveClaudeCount } from '../../lib/claude';

const g = globalThis as unknown as { __apiChecks?: { minute: number; n: number } };
function allowed(): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  if (!g.__apiChecks || g.__apiChecks.minute !== minute) g.__apiChecks = { minute, n: 0 };
  return ++g.__apiChecks.n <= 40;
}

/**
 * Probes one server live and returns the result as JSON. claudeTokens is the
 * exact count from the Anthropic count_tokens endpoint, when the Worker has a
 * key. toolsTokensEstimate comes from the schema size; the per-tool byte sizes
 * let a caller count o200k exactly.
 */
export const GET: APIRoute = async ({ url, site }) => {
  const target = (url.searchParams.get('url') ?? '').trim().slice(0, 500);
  const base = (site ?? new URL('https://mcp-pulse.ulehla.dev')).toString().replace(/\/$/, '');
  const headers = { 'cache-control': 'public, max-age=60, s-maxage=600', 'access-control-allow-origin': '*' };
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return Response.json({ error: 'pass ?url=https://…' }, { status: 400, headers });
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) return Response.json({ error: 'only public https URLs' }, { status: 400, headers });
  const known = await findByUrl(u.toString());
  if (known) return Response.json({ inRegistry: true, name: known, page: `${base}/s/${known}`, api: `${base}/api/s/${known}.json` }, { headers });
  if (!allowed()) return Response.json({ error: 'too many live checks, try again in a minute' }, { status: 429, headers: { 'cache-control': 'no-store' } });
  const type = /\/sse\/?$/.test(u.pathname) ? 'sse' : 'streamable-http';
  const { result, tools } = await probeRemoteRaw({ url: u.toString(), type }, { timeoutMs: 10_000 });
  const sized = tools.map((t) => ({ name: t.name, bytes: payloadBytes(t) }));
  const bytes = sized.reduce((a, t) => a + t.bytes, 0);
  const claude = result.status === 'ok' ? await liveClaudeCount(tools, u.hostname) : null;
  return Response.json(
    {
      inRegistry: false,
      url: result.url,
      status: result.status,
      httpStatus: result.httpStatus,
      authScheme: result.authScheme,
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      latencyMs: result.latencyMs,
      toolCount: result.toolCount,
      claudeTokens: claude?.tokens,
      claudeTokensClaudeCode: claude?.tokensClaudeCode,
      claudeModel: claude?.model,
      claudeError: claude?.error,
      toolsBytes: bytes,
      toolsTokensEstimate: Math.round(bytes / BYTES_PER_TOKEN),
      estimateNote: `bytes / ${BYTES_PER_TOKEN}, the registry median; exact o200k count: npx mcptop --url ${result.url}`,
      tools: sized,
      error: result.error,
      probedAt: result.probedAt
    },
    { headers: result.status === 'ok' ? headers : { ...headers, 'cache-control': 'public, max-age=30, s-maxage=120' } }
  );
};
