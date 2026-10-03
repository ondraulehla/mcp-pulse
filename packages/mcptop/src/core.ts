/**
 * The transport-level probe without token counting. The board's Worker imports
 * this file, so it must not pull in the tokenizer (its tables take CPU to load).
 * probe.ts and stdio.ts add the token costs on top.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { jsonSchemaValidator, JsonSchemaValidator, JsonSchemaValidatorResult } from '@modelcontextprotocol/sdk/validation/types.js';
import type { ProbeResult, ProbeStatus, RemoteTransport } from './types.js';

export const VERSION = '0.1.1';
export const USER_AGENT = `mcp-pulse/${VERSION} (mcptop; +https://github.com/ondraulehla/mcp-pulse)`;

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CoreOptions {
  /** Timeout for the whole probe and for each request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Extra request headers, for example an Authorization header from your config. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface RawProbe {
  result: ProbeResult;
  tools: RawTool[];
}

interface Observed {
  status: number;
  headers: Headers;
  url: string;
}

export function emptyResult(url: string, transport: ProbeResult['transport']): ProbeResult {
  return { url, transport, probedAt: new Date().toISOString(), status: 'error', latencyMs: {} };
}

/** Connects to a remote MCP server and lists its tools. No token counting. */
export async function probeRemoteRaw(remote: { url: string; type: RemoteTransport }, options: CoreOptions = {}): Promise<RawProbe> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseFetch = options.fetch ?? fetch;
  const result = emptyResult(remote.url, remote.type);

  let url: URL;
  try {
    url = new URL(remote.url);
  } catch {
    result.error = 'invalid URL';
    return { result, tools: [] };
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

  // Follow redirects across origins too: a server that moved should be measured where it lives.
  const requestInit: RequestInit = { headers: options.headers };
  const transport =
    remote.type === 'sse'
      ? new SSEClientTransport(url, { fetch: observingFetch, requestInit, redirectPolicy: 'follow' })
      : new StreamableHTTPClientTransport(url, { fetch: observingFetch, requestInit, redirectPolicy: 'follow' });

  const tools = await measure(transport, result, timeoutMs);

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
  return { result, tools };
}

/** The part every transport shares: initialize, read the server info, list the tools. */
/**
 * The probe never calls a tool, so it never validates a tool result. A no-op
 * validator skips the SDK's default, which compiles schemas with new Function
 * and is refused inside Cloudflare Workers.
 */
const noValidation: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: input as T, errorMessage: undefined });
  }
};

export async function measure(transport: Transport, result: ProbeResult, timeoutMs: number): Promise<RawTool[]> {
  const client = new Client({ name: 'mcp-pulse', version: VERSION }, { capabilities: {}, jsonSchemaValidator: noValidation });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`probe timed out after ${timeoutMs} ms`), { name: 'TimeoutError' })), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const tools: RawTool[] = [];
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
    result.toolCount = tools.length;
    result.status = 'ok';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; code?: string } };
    result.error = [e?.message ?? String(err), e?.cause?.message, e?.cause?.code].filter(Boolean).join(' | ').slice(0, 400);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
  return tools;
}

export function classify(message: string | undefined, first: Observed | undefined): ProbeStatus {
  const text = message ?? '';
  if (first) {
    if (first.status === 401 || first.status === 403) return 'auth';
    if (first.status === 402) return 'payment';
    if (first.status === 404 || first.status === 405 || first.status === 410) return 'not_found';
    if (first.status === 429) return 'rate_limited';
    // Inside Cloudflare Workers a failed origin fetch comes back as a 52x/530 page.
    if (first.status === 530 || /error code: 10(00|16)/.test(text)) return 'dns';
    if (first.status === 522 || first.status === 524) return 'timeout';
    if (first.status === 521 || first.status === 523) return 'refused';
    if (first.status === 525 || first.status === 526) return 'tls';
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
