import type { APIRoute } from 'astro';
import { latestRun } from '../../lib/db';

/** The latest run's aggregates. */
export const GET: APIRoute = async () => {
  const run = await latestRun();
  if (!run) return Response.json({ error: 'no run yet' }, { status: 503 });
  return Response.json(
    { ...run, fields: { claudeTokens: 'exact, Anthropic count_tokens', toolsTokens: 'estimate, o200k_base over compact JSON' }, source: 'https://mcp-pulse.ulehla.dev', license: 'MIT' },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=3600', 'access-control-allow-origin': '*' } }
  );
};
