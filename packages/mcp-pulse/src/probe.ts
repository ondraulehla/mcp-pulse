import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { toolsCost } from './tokens.js';
import type { ProbeResult, ProbeStatus, RemoteTransport } from './types.js';

export const VERSION = '0.0.0';
export const USER_AGENT = `mcp-pulse/${VERSION} (+https://github.com/ondraulehla/mcp-pulse)`;

export interface ProbeOptions {
  /** Timeout for the whole probe and for each request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Keep the per-tool list in the result. Default true. */
  includeTools?: boolean;
  fetch?: typeof fetch;
}

interface Observed {
  status: number;
  headers: Headers;
  url: string;
}

/** Connects to a remote MCP server, lists its tools and measures what it costs. */
export async function probeRemote(
  remote: { url: string; type: RemoteTransport },
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const includeTools = options.includeTools ?? true;
  const baseFetch = options.fetch ?? fetch;

  const result: ProbeResult = {
    url: remote.url,
    transport: remote.type,
    probedAt: new Date().toISOString(),
    status: 'error',
    latencyMs: {}
  };

  let url: URL;
  try {
    url = new URL(remote.url);
  } catch {
    result.error = 'invalid URL';
    return result;
  }

  let first: Observed | undefined;
  const observingFetch: typeof fetch = async (input, init) => {
    // The probe needs no server-initiated messages. Answering 405 to the standalone
    // GET makes the SDK skip that stream, which otherwise stalls tools/list on some
    // servers (DeepWiki held it for 15 s and never answered the POST meanwhile).
    if (remote.type !== 'sse' && (init?.method ?? 'GET') === 'GET') {
      return new Response(null, { status: 405 });
    }
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const headers = new Headers(init?.headers);
    headers.set('user-agent', USER_AGENT);
    const res = await baseFetch(input, { ...init, headers, signal });
    first ??= { status: res.status, headers: res.headers, url: String(input instanceof Request ? input.url : input) };
    return res;
  };

  const client = new Client({ name: 'mcp-pulse', version: VERSION }, { capabilities: {} });
  const transport =
    remote.type === 'sse'
      ? new SSEClientTransport(url, { fetch: observingFetch, requestInit: { redirect: 'follow' } })
      : new StreamableHTTPClientTransport(url, { fetch: observingFetch, requestInit: { redirect: 'follow' } });

  try {
    const t0 = performance.now();
    await client.connect(transport, { timeout: timeoutMs });
    result.latencyMs.initialize = Math.round(performance.now() - t0);
    result.httpStatus = first?.status;

    const info = client.getServerVersion();
    if (info) result.serverInfo = { name: info.name, version: info.version, title: info.title };
    const caps = client.getServerCapabilities() ?? {};
    result.capabilities = Object.keys(caps).sort();
    result.instructionsChars = client.getInstructions()?.length ?? 0;
    result.protocolVersion = (transport as { protocolVersion?: string }).protocolVersion;

    if (caps.tools) {
      const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
      let cursor: string | undefined;
      const t1 = performance.now();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 2_000);
      result.latencyMs.toolsList = Math.round(performance.now() - t1);
      const cost = toolsCost(tools);
      result.toolCount = tools.length;
      result.toolsTokens = cost.tokens;
      result.toolsBytes = cost.bytes;
      if (includeTools) result.tools = cost.tools;
    } else {
      result.toolCount = 0;
      result.toolsTokens = 0;
      result.toolsBytes = 0;
      if (includeTools) result.tools = [];
    }
    result.status = 'ok';
  } catch (err) {
    const classified = classify(err, first);
    result.status = classified.status;
    result.error = classified.message;
    if (first) {
      result.httpStatus = first.status;
      const www = first.headers.get('www-authenticate');
      if (www) {
        result.authScheme = www.split(/[\s,]/)[0];
        const m = /resource_metadata="([^"]+)"/i.exec(www);
        if (m) result.authResourceMetadata = m[1];
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  return result;
}

function classify(err: unknown, first: Observed | undefined): { status: ProbeStatus; message: string } {
  const e = err as { name?: string; message?: string; code?: unknown; cause?: { code?: string; message?: string } };
  const message = String(e?.message ?? err).slice(0, 300);
  const causeCode = e?.cause?.code ?? '';
  const text = `${message} ${e?.cause?.message ?? ''} ${causeCode}`;

  if (first) {
    if (first.status === 401 || first.status === 403) return { status: 'auth', message };
    if (first.status === 402) return { status: 'payment', message };
    if (first.status === 404 || first.status === 405 || first.status === 410) return { status: 'not_found', message };
    if (first.status === 429) return { status: 'rate_limited', message };
    if (first.status >= 500) return { status: 'server_error', message };
    if (first.status >= 200 && first.status < 300) {
      if (/timed? ?out|TimeoutError/i.test(text)) return { status: 'timeout', message };
      return { status: 'protocol_error', message };
    }
  }
  if (e?.name === 'TimeoutError' || /timed? ?out|TimeoutError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(text)) {
    return { status: 'timeout', message };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return { status: 'dns', message };
  if (/CERT_|certificate|TLS|SSL|ERR_TLS/i.test(text)) return { status: 'tls', message };
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET/i.test(text)) {
    return { status: 'refused', message };
  }
  return { status: 'error', message };
}
