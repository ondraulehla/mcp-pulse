import type { APIRoute } from 'astro';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { findByUrl, getServer, latestRun, listServers, SORTS, MAX_NUMBERED_PAGE, decodeCursor, encodeCursor, type SortKey } from '../lib/db';
import { label } from '../lib/format';
import { probeRemoteRaw } from '../../../packages/mcptop/src/core.ts';
import { payloadBytes, BYTES_PER_TOKEN } from '../../../packages/mcptop/src/payload.ts';
import { liveClaudeCount } from '../lib/claude';

const SITE = 'https://mcp-pulse.ulehla.dev';

/**
 * mcp-pulse as an MCP server: three tools over the same data as the board.
 * Stateless, one server instance per request, JSON responses.
 */
function build(): McpServer {
  const server = new McpServer(
    { name: 'mcp-pulse', version: '0.1.2' },
    {
      instructions:
        'Health and token cost of every remote server in the official MCP registry, probed daily. Use lookup_server for a registry name or URL, search_servers to find servers, check_server to probe a URL that is not in the registry. claudeTokens is the exact count from the Anthropic count_tokens endpoint (claudeTokensClaudeCode with the mcp__<server>__ prefix); toolsTokens is an o200k_base estimate over each tool definition.'
    }
  );

  server.registerTool(
    'lookup_server',
    {
      title: 'Look up a registry server',
      description: 'Latest probe of one server from the official MCP registry: status, protocol, tool count, exact token cost of its tool definitions in Claude, latency. Accepts the registry name (io.github.owner/name) or the server URL.',
      inputSchema: { nameOrUrl: z.string().describe('Registry name or https URL of the server') }
    },
    async ({ nameOrUrl }) => {
      const name = /^https?:\/\//.test(nameOrUrl) ? await findByUrl(nameOrUrl) : nameOrUrl;
      const s = name ? await getServer(name) : null;
      if (!s) return { content: [{ type: 'text', text: `No registry server matches ${nameOrUrl}. Use check_server to probe a URL live.` }], isError: true };
      const out = {
        name: s.name, title: s.title, url: s.url, status: s.status, statusLabel: label(s.status), httpStatus: s.http_status, authScheme: s.auth_scheme,
        protocolVersion: s.protocol_version, toolCount: s.tool_count,
        claudeTokens: s.claude_tokens, claudeTokensClaudeCode: s.claude_tokens_cc, claudeModel: s.claude_model, claudeError: s.claude_error,
        toolsTokens: s.tools_tokens, toolsTokensNote: 'o200k_base estimate; claudeTokens is exact',
        shareOf200k: (s.claude_tokens ?? s.tools_tokens) != null ? Number((((s.claude_tokens ?? s.tools_tokens)! / 200_000) * 100).toFixed(2)) : null,
        latencyMs: { initialize: s.init_ms, toolsList: s.tools_ms }, topTools: s.top_tools ? JSON.parse(s.top_tools) : null,
        probedAt: s.probed_at, page: `${SITE}/s/${s.name}`
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  server.registerTool(
    'search_servers',
    {
      title: 'Search the registry board',
      description: 'Find servers by words in name, title, description or host, with optional filters, sorted by exact Claude token cost by default. Returns up to 20 servers per page; page numbers go to 20, after that pass the `next` cursor from the previous answer.',
      inputSchema: {
        query: z.string().optional().describe('Words to match, three or more characters each'),
        status: z.enum(['ok', 'auth', 'payment', 'newer_protocol', 'down']).optional().describe('ok = answers and lists tools'),
        sort: z.enum(Object.keys(SORTS) as [SortKey, ...SortKey[]]).optional(),
        page: z.number().int().min(1).max(MAX_NUMBERED_PAGE).optional(),
        cursor: z.string().optional().describe('The `next` value of a previous answer, to continue from there')
      }
    },
    async ({ query, status, sort, page, cursor }) => {
      const { rows, hasNext, nextCursor } = await listServers({ q: query, status, sort: sort ?? 'claude', page: page ?? 1, perPage: 20, cursor: decodeCursor(cursor) });
      const out = { page: cursor ? undefined : (page ?? 1), hasNext, next: hasNext && nextCursor ? encodeCursor(nextCursor) : null, servers: rows.map((r) => ({ name: r.name, title: r.title, host: r.host, status: r.status, toolCount: r.tool_count, claudeTokens: r.claude_tokens, toolsTokens: r.tools_tokens, protocolVersion: r.protocol_version, page: `${SITE}/s/${r.name}` })) };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  server.registerTool(
    'check_server',
    {
      title: 'Probe a server live',
      description: 'Connects to an MCP server URL now (initialize and tools/list, no credentials, 10 s timeout) and reports status, protocol, tools and the token cost of the tool definitions: exact in Claude when the counter is available, else an estimate from the schema size. For registry servers prefer lookup_server.',
      inputSchema: { url: z.string().url().describe('https URL of the MCP endpoint') }
    },
    async ({ url }) => {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !u.hostname.includes('.')) return { content: [{ type: 'text', text: 'Only public https URLs can be probed.' }], isError: true };
      const known = await findByUrl(u.toString());
      if (known) {
        const s = await getServer(known);
        if (s) return { content: [{ type: 'text', text: JSON.stringify({ inRegistry: true, name: s.name, status: s.status, toolCount: s.tool_count, claudeTokens: s.claude_tokens, toolsTokens: s.tools_tokens, page: `${SITE}/s/${s.name}` }, null, 2) }] };
      }
      const { result, tools } = await probeRemoteRaw({ url: u.toString(), type: /\/sse\/?$/.test(u.pathname) ? 'sse' : 'streamable-http' }, { timeoutMs: 10_000 });
      const bytes = tools.reduce((a, t) => a + payloadBytes(t), 0);
      const claude = result.status === 'ok' ? await liveClaudeCount(tools, u.hostname) : null;
      const out = {
        url: result.url, status: result.status, statusLabel: label(result.status), httpStatus: result.httpStatus, authScheme: result.authScheme,
        protocolVersion: result.protocolVersion, serverInfo: result.serverInfo, toolCount: result.toolCount, toolsBytes: bytes,
        claudeTokens: claude?.tokens, claudeTokensClaudeCode: claude?.tokensClaudeCode, claudeModel: claude?.model, claudeError: claude?.error,
        toolsTokensEstimate: Math.round(bytes / BYTES_PER_TOKEN), estimateNote: 'estimated from schema size at the registry median of 4.42 bytes per token; exact o200k: npx mcptop --url <url>',
        tools: tools.map((t) => t.name), latencyMs: result.latencyMs, error: result.error
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  server.registerTool(
    'registry_summary',
    { title: 'Registry summary', description: 'Aggregates of the latest daily run: how many servers answer, token cost percentiles, protocol versions, heaviest servers.', inputSchema: {} },
    async () => {
      const run = await latestRun();
      return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }], structuredContent: run ?? undefined };
    }
  );
  return server;
}

async function handle(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build();
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request);
    const h = new Headers(res.headers);
    h.set('access-control-allow-origin', '*');
    h.set('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-session-id, accept');
    h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers: h });
  } finally {
    await server.close().catch(() => undefined);
  }
}

export const POST: APIRoute = ({ request }) => handle(request);
export const GET: APIRoute = ({ request }) => handle(request);
export const DELETE: APIRoute = ({ request }) => handle(request);
export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, accept' } });
