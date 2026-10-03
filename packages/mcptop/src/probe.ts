import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { toolsCost } from './tokens.js';
import type { ProbeResult, ProbeStatus, RemoteTransport } from './types.js';

export const VERSION = '0.1.0';
export const USER_AGENT = `mcp-pulse/${VERSION} (mcptop; +https://github.com/ondraulehla/mcp-pulse)`;

export interface ProbeOptions {
  /** Timeout for the whole probe and for each request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Keep the per-tool list in the result. Default true. */
  includeTools?: boolean;
  /** Extra request headers, for example an Authorization header from your config. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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
  const baseFetch = options.fetch ?? fetch;
  const result = emptyResult(remote.url, remote.type);

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

  const requestInit: RequestInit = { redirect: 'follow', headers: options.headers };
  const transport =
    remote.type === 'sse'
      ? new SSEClientTransport(url, { fetch: observingFetch, requestInit })
      : new StreamableHTTPClientTransport(url, { fetch: observingFetch, requestInit });

  await measure(transport, result, options);

  if (result.status === 'ok') {
    result.httpStatus = first?.status;
  } else {
    result.status = classify(result.error, first);
    if (first) {
      result.httpStatus = first.status;
      const www = first.headers.get('www-authenticate');
      if (www) {
        result.authScheme = www.split(/[\s,]/)[0];
        const m = /resource_metadata="([^"]+)"/i.exec(www);
        if (m) result.authResourceMetadata = m[1];
      }
    }
  }
  return result;
}

/** Starts a local MCP server over stdio, lists its tools and measures what it costs. */
export async function probeStdio(target: StdioTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const label = [target.command, ...(target.args ?? [])].join(' ');
  const result = emptyResult(`stdio:${label}`, 'stdio');
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    cwd: target.cwd,
    env: { ...getDefaultEnvironment(), ...(target.env ?? {}) },
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderrChunks.join('').length < 2_000) stderrChunks.push(chunk.toString('utf8'));
  });

  await measure(transport, result, options);

  if (result.status !== 'ok') {
    const stderr = stderrChunks.join('').trim();
    const text = `${result.error ?? ''} ${stderr}`;
    if (/ENOENT/.test(text)) {
      result.status = 'not_found';
      result.error = `command not found: ${target.command}`;
    } else if (/timed? ?out|TimeoutError/i.test(text)) {
      result.status = 'timeout';
    } else {
      result.status = /JSON|parse|Unexpected token/i.test(text) ? 'protocol_error' : 'error';
    }
    if (stderr && result.status !== 'not_found') result.error = `${result.error ?? ''}\n${stderr.slice(-400)}`.trim();
  }
  return result;
}

function emptyResult(url: string, transport: ProbeResult['transport']): ProbeResult {
  return { url, transport, probedAt: new Date().toISOString(), status: 'error', latencyMs: {} };
}

/** The part every transport shares: initialize, read the server info, list and price the tools. */
async function measure(transport: Transport, result: ProbeResult, options: ProbeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const includeTools = options.includeTools ?? true;
  const client = new Client({ name: 'mcp-pulse', version: VERSION }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`probe timed out after ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs);
    timer.unref();
  });
  try {
    const t0 = performance.now();
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), deadline]);
    result.latencyMs.initialize = Math.round(performance.now() - t0);

    const info = client.getServerVersion();
    if (info) result.serverInfo = { name: info.name, version: info.version, title: info.title };
    const caps = client.getServerCapabilities() ?? {};
    result.capabilities = Object.keys(caps).sort();
    result.instructionsChars = client.getInstructions()?.length ?? 0;
    result.protocolVersion = (transport as { protocolVersion?: string }).protocolVersion;

    const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    if (caps.tools) {
      let cursor: string | undefined;
      const t1 = performance.now();
      do {
        const page = await Promise.race([client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }), deadline]);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 2_000);
      result.latencyMs.toolsList = Math.round(performance.now() - t1);
    }
    const cost = toolsCost(tools);
    result.toolCount = tools.length;
    result.toolsTokens = cost.tokens;
    result.toolsBytes = cost.bytes;
    if (includeTools) result.tools = cost.tools;
    result.status = 'ok';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; code?: string } };
    result.error = [e?.message ?? String(err), e?.cause?.message, e?.cause?.code].filter(Boolean).join(' | ').slice(0, 400);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

function classify(message: string | undefined, first: Observed | undefined): ProbeStatus {
  const text = message ?? '';
  if (first) {
    if (first.status === 401 || first.status === 403) return 'auth';
    if (first.status === 402) return 'payment';
    if (first.status === 404 || first.status === 405 || first.status === 410) return 'not_found';
    if (first.status === 429) return 'rate_limited';
    if (first.status >= 500) return 'server_error';
    if (first.status >= 200 && first.status < 300) {
      if (/timed? ?out|TimeoutError/i.test(text)) return 'timeout';
      return 'protocol_error';
    }
  }
  if (/timed? ?out|TimeoutError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(text)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'dns';
  if (/CERT_|certificate|TLS|SSL|ERR_TLS/i.test(text)) return 'tls';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET/i.test(text)) return 'refused';
  return 'error';
}
