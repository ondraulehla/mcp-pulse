import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

async function configWith(servers: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-pulse-cli-'));
  const file = path.join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

async function exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', cli, ...args], { timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('cli', () => {
  it('prints help', async () => {
    const { code, stdout } = await exec(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--budget');
  });

  it('measures a config file and prints a table with a total', async () => {
    const file = await configWith({
      local: { command: process.execPath, args: [fixture] },
      off: { command: 'never', disabled: true },
      missing: { command: 'definitely-not-a-command-mcp-pulse' }
    });
    const { code, stdout } = await exec(['--config', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('local');
    expect(stdout).toContain('alive');
    expect(stdout).toContain('skipped: disabled in config');
    expect(stdout).toContain('command not found');
    expect(stdout).toMatch(/total .*1 of 3 measured/);
  });

  it('emits JSON with per-server and total numbers', async () => {
    const file = await configWith({ local: { command: process.execPath, args: [fixture] } });
    const { code, stdout } = await exec(['--config', file, '--json', '--tools', '1', '--window', '100000']);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.window).toBe(100000);
    expect(out.total.servers).toBe(1);
    expect(out.total.tools).toBe(2);
    expect(out.total.tokens).toBeGreaterThan(20);
    expect(out.total.shareOfWindow).toBeCloseTo(out.total.tokens / 100000, 6);
    expect(out.servers[0]).toMatchObject({ name: 'local', kind: 'stdio', status: 'ok', toolCount: 2 });
    expect(out.servers[0].tools).toHaveLength(1);
  });

  it('skips local servers with --no-stdio', async () => {
    const file = await configWith({ local: { command: process.execPath, args: [fixture] } });
    const { code, stdout } = await exec(['--config', file, '--json', '--no-stdio']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).servers[0].skipped).toContain('--no-stdio');
  });

  it('fails the budget', async () => {
    const file = await configWith({ local: { command: process.execPath, args: [fixture] } });
    const { code, stderr } = await exec(['--config', file, '--budget', '1']);
    expect(code).toBe(1);
    expect(stderr).toContain('Over budget');
  });

  it('exits 2 for an unreadable config', async () => {
    const { code } = await exec(['--config', '/nope/none.json']);
    expect(code).toBe(2);
  });
});
