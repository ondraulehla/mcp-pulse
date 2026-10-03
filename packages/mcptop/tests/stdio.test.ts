import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeStdio } from '../src/stdio.js';

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

describe('probeStdio', () => {
  it('starts a local server, lists its tools and prices them', async () => {
    const r = await probeStdio({ command: process.execPath, args: [fixture] }, { timeoutMs: 10_000 });
    expect(r.status).toBe('ok');
    expect(r.transport).toBe('stdio');
    expect(r.url).toBe(`stdio:${process.execPath} ${fixture}`);
    expect(r.serverInfo).toMatchObject({ name: 'stdio-fixture', version: '0.1.0' });
    expect(r.toolCount).toBe(2);
    expect(r.tools?.map((t) => t.name).sort()).toEqual(['add', 'env']);
    expect(r.toolsTokens).toBeGreaterThan(20);
    expect(r.instructionsChars).toBe('Fixture.'.length);
  });

  it('passes env through and keeps stderr out of the result on success', async () => {
    const r = await probeStdio({ command: process.execPath, args: [fixture], env: { FIXTURE_FLAG: 'noisy' } }, { timeoutMs: 10_000 });
    expect(r.status).toBe('ok');
    expect(r.error).toBeUndefined();
  });

  it('reports a missing command', async () => {
    const r = await probeStdio({ command: 'definitely-not-a-command-mcp-pulse' }, { timeoutMs: 5_000 });
    expect(r.status).toBe('not_found');
    expect(r.error).toContain('command not found');
  });

  it('reports a process that is not an MCP server', async () => {
    const r = await probeStdio({ command: process.execPath, args: ['-e', 'console.log("hello"); setTimeout(() => {}, 1000)'] }, { timeoutMs: 3_000 });
    expect(['protocol_error', 'timeout', 'error']).toContain(r.status);
    expect(r.status).not.toBe('ok');
  });
});
