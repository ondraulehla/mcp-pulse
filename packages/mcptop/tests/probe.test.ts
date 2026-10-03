import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { probeRemote, USER_AGENT } from '../src/probe.js';

describe('probeRemote against a real in-process server', () => {
  let http: Server;
  let url: string;
  const seenUserAgents: string[] = [];

  beforeAll(async () => {
    http = createServer(async (req, res) => {
      seenUserAgents.push(req.headers['user-agent'] ?? '');
      const mcp = new McpServer({ name: 'fixture', version: '1.2.3' }, { instructions: 'Use echo for tests.' });
      mcp.registerTool('echo', { description: 'Returns the input.', inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: 'text', text }]
      }));
      mcp.registerTool('now', { description: 'Returns the time.' }, async () => ({ content: [{ type: 'text', text: 'now' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  it('reports ok, lists the tools and measures their cost', async () => {
    const r = await probeRemote({ url, type: 'streamable-http' }, { timeoutMs: 5_000 });
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.serverInfo).toMatchObject({ name: 'fixture', version: '1.2.3' });
    expect(r.capabilities).toContain('tools');
    expect(r.instructionsChars).toBe('Use echo for tests.'.length);
    expect(r.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.toolCount).toBe(2);
    expect(r.tools?.map((t) => t.name).sort()).toEqual(['echo', 'now']);
    expect(r.toolsTokens).toBe(r.tools!.reduce((s, t) => s + t.tokens, 0));
    expect(r.toolsTokens).toBeGreaterThan(20);
    expect(r.latencyMs.initialize).toBeGreaterThanOrEqual(0);
    expect(r.latencyMs.toolsList).toBeGreaterThanOrEqual(0);
    expect(seenUserAgents.every((ua) => ua === USER_AGENT)).toBe(true);
  });

  it('leaves the per-tool list out when asked', async () => {
    const r = await probeRemote({ url, type: 'streamable-http' }, { timeoutMs: 5_000, includeTools: false });
    expect(r.status).toBe('ok');
    expect(r.tools).toBeUndefined();
    expect(r.toolCount).toBe(2);
  });

  it('never opens the standalone GET stream', async () => {
    const methods: string[] = [];
    const spy: typeof fetch = (input, init) => {
      methods.push(init?.method ?? 'GET');
      return fetch(input, init);
    };
    const r = await probeRemote({ url, type: 'streamable-http' }, { timeoutMs: 5_000, fetch: spy });
    expect(r.status).toBe('ok');
    expect(methods).not.toContain('GET');
  });
});

describe('probeRemote classification with a fake fetch', () => {
  const respond = (status: number, headers: Record<string, string> = {}, body = ''): typeof fetch =>
    async () => new Response(body, { status, headers });
  const fail = (error: unknown): typeof fetch => async () => { throw error; };
  const target = { url: 'https://fixture.example/mcp', type: 'streamable-http' as const };

  it('maps 401 with WWW-Authenticate to auth and keeps the scheme and resource metadata', async () => {
    const r = await probeRemote(target, {
      fetch: respond(401, { 'www-authenticate': 'Bearer resource_metadata="https://fixture.example/.well-known/oauth-protected-resource", error="invalid_token"' })
    });
    expect(r.status).toBe('auth');
    expect(r.httpStatus).toBe(401);
    expect(r.authScheme).toBe('Bearer');
    expect(r.authResourceMetadata).toBe('https://fixture.example/.well-known/oauth-protected-resource');
  });

  it.each([
    [402, 'payment'],
    [403, 'auth'],
    [404, 'not_found'],
    [405, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error']
  ])('maps HTTP %i to %s', async (status, expected) => {
    const r = await probeRemote(target, { fetch: respond(status) });
    expect(r.status).toBe(expected);
    expect(r.httpStatus).toBe(status);
  });

  it('maps a 200 that is not MCP to protocol_error', async () => {
    const r = await probeRemote(target, { fetch: respond(200, { 'content-type': 'text/html' }, '<html>hi</html>') });
    expect(r.status).toBe('protocol_error');
  });

  it('maps a JSON-RPC error on initialize to protocol_error', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32602, message: 'Missing required _meta' } });
    const r = await probeRemote(target, { fetch: respond(200, { 'content-type': 'application/json' }, body) });
    expect(r.status).toBe('protocol_error');
    expect(r.error).toContain('Missing required _meta');
  });

  it('maps DNS, TLS, refused and timeout failures', async () => {
    const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    expect((await probeRemote(target, { fetch: fail(withCause('ENOTFOUND')) })).status).toBe('dns');
    expect((await probeRemote(target, { fetch: fail(withCause('ECONNREFUSED')) })).status).toBe('refused');
    expect((await probeRemote(target, { fetch: fail(withCause('ERR_TLS_CERT_ALTNAME_INVALID')) })).status).toBe('tls');
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect((await probeRemote(target, { fetch: fail(timeout) })).status).toBe('timeout');
  });

  it('rejects an invalid URL without touching the network', async () => {
    const r = await probeRemote({ url: 'not a url', type: 'streamable-http' }, { fetch: fail(new Error('must not be called')) });
    expect(r.status).toBe('error');
    expect(r.error).toBe('invalid URL');
  });
});
