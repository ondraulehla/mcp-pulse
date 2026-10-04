import type { APIRoute } from 'astro';
import { getHistory, getServer } from '../../../lib/db';
import { label } from '../../../lib/format';

/** One server as JSON: the latest probe plus its history. */
export const GET: APIRoute = async ({ params, site }) => {
  const name = (params.name ?? '').replace(/\.json$/, '');
  const server = name ? await getServer(name) : null;
  if (!server) return Response.json({ error: 'unknown server', name }, { status: 404 });
  const history = await getHistory(name, 30);
  const base = (site ?? new URL('https://mcp-pulse.ulehla.dev')).toString().replace(/\/$/, '');
  return Response.json(
    {
      name: server.name,
      title: server.title,
      description: server.description,
      url: server.url,
      transport: server.transport,
      host: server.host,
      page: `${base}/s/${server.name}`,
      status: server.status,
      statusLabel: label(server.status),
      httpStatus: server.http_status,
      authScheme: server.auth_scheme,
      protocolVersion: server.protocol_version,
      serverInfo: server.server_name ? { name: server.server_name, version: server.server_version } : null,
      capabilities: server.capabilities ? JSON.parse(server.capabilities) : null,
      latencyMs: { initialize: server.init_ms, toolsList: server.tools_ms },
      toolCount: server.tool_count,
      claudeTokens: server.claude_tokens,
      claudeTokensClaudeCode: server.claude_tokens_cc,
      claudeModel: server.claude_model,
      claudeMeasuredAt: server.claude_measured_at,
      claudeError: server.claude_error,
      toolsTokens: server.tools_tokens,
      shareOf200k: (server.claude_tokens ?? server.tools_tokens) != null ? Number((((server.claude_tokens ?? server.tools_tokens)! / 200_000) * 100).toFixed(2)) : null,
      fields: { claudeTokens: 'exact, Anthropic count_tokens, names as published', claudeTokensClaudeCode: 'exact, with the mcp__<server>__ prefix', toolsTokens: 'estimate, o200k_base over compact JSON' },
      instructionsChars: server.instructions_chars,
      topTools: server.top_tools ? JSON.parse(server.top_tools) : null,
      toolsetSiblings: server.toolset_siblings,
      registry: { status: server.registry_status, updatedAt: server.registry_updated_at, repo: server.repo, website: server.website },
      probedAt: server.probed_at,
      history: history.map((h) => ({ probedAt: h.probed_at, status: h.status, initMs: h.init_ms, toolCount: h.tool_count, toolsTokens: h.tools_tokens, claudeTokens: h.claude_tokens }))
    },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=3600', 'access-control-allow-origin': '*' } }
  );
};
