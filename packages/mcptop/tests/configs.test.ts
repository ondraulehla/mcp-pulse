import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverConfigs, expand, knownConfigPaths, normalizeServers, readConfigFile } from '../src/configs.js';

describe('expand', () => {
  it('replaces ${VAR} and ${VAR:-default}', () => {
    const env = { TOKEN: 'abc' };
    expect(expand('Bearer ${TOKEN}', env)).toBe('Bearer abc');
    expect(expand('${MISSING:-fallback}', env)).toBe('fallback');
    expect(expand('${MISSING}', env)).toBe('${MISSING}');
    expect(expand('${TOKEN:-x}/${TOKEN}', env)).toBe('abc/abc');
  });
});

describe('normalizeServers', () => {
  it('reads remote servers in the shapes clients write', () => {
    const servers = normalizeServers(
      {
        a: { url: 'https://a.example/mcp' },
        b: { type: 'http', url: 'https://b.example/mcp', headers: { Authorization: 'Bearer ${T}' } },
        c: { type: 'sse', url: 'https://c.example/events' },
        d: { url: 'https://d.example/sse' },
        e: { serverUrl: 'https://e.example/mcp', disabled: true }
      },
      'test',
      { T: 'tok' }
    );
    expect(servers.map((s) => [s.name, s.kind, s.type, s.disabled ?? false])).toEqual([
      ['a', 'remote', 'streamable-http', false],
      ['b', 'remote', 'streamable-http', false],
      ['c', 'remote', 'sse', false],
      ['d', 'remote', 'sse', false],
      ['e', 'remote', 'streamable-http', true]
    ]);
    expect(servers[1].headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('reads stdio servers with args, env and cwd', () => {
    const [s] = normalizeServers(
      { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${HOME}/docs'], env: { DEBUG: '1' }, cwd: '/tmp' } },
      'test',
      { HOME: '/home/me' }
    );
    expect(s).toMatchObject({ name: 'fs', kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/docs'], env: { DEBUG: '1' }, cwd: '/tmp' });
  });

  it('skips entries it cannot run', () => {
    expect(normalizeServers({ x: { note: 'nothing here' }, y: null, z: 'str' }, 'test', {})).toEqual([]);
  });
});

describe('discoverConfigs', () => {
  it('finds the files of each client under a fake home and cwd', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-pulse-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'proj');
    await mkdir(path.join(cwd, '.cursor'), { recursive: true });
    await mkdir(path.join(cwd, '.vscode'), { recursive: true });
    await mkdir(path.join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    await writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { url: 'https://p.example/mcp' } } }));
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { user: { command: 'u' } },
        projects: {
          [cwd]: { mcpServers: { scoped: { command: 's' } } },
          '/elsewhere': { mcpServers: { other: { command: 'o' } } }
        }
      })
    );
    await writeFile(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { desk: { command: 'd' } } }));
    await writeFile(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cur: { url: 'https://c.example/mcp' } } }));
    await writeFile(path.join(cwd, '.vscode', 'mcp.json'), JSON.stringify({ servers: { code: { type: 'http', url: 'https://v.example/mcp' } } }));
    await writeFile(path.join(cwd, '.vscode', 'junk.json'), 'not json');

    const found = await discoverConfigs({ cwd, home, platform: 'darwin', env: {} });
    const names = found.flatMap((f) => f.servers.map((s) => `${f.client}:${s.name}`)).sort();
    expect(names).toEqual([
      'Claude Code (project):proj',
      'Claude Code (user):scoped',
      'Claude Code (user):user',
      'Claude Desktop:desk',
      'Cursor (project):cur',
      'VS Code (workspace):code'
    ]);
    expect(names).not.toContain('Claude Code (user):other');
  });

  it('knows the Windows and Linux desktop paths', () => {
    const win = knownConfigPaths({ home: 'C:\\Users\\me', platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, cwd: 'C:\\p' });
    expect(win.find((p) => p.client === 'Claude Desktop')?.path).toContain('Roaming');
    const linux = knownConfigPaths({ home: '/home/me', platform: 'linux', env: {}, cwd: '/p' });
    expect(linux.find((p) => p.client === 'Claude Desktop')?.path).toBe('/home/me/.config/Claude/claude_desktop_config.json');
  });

  it('returns null for a missing file', async () => {
    expect(await readConfigFile('/nope/none.json', 'x')).toBeNull();
  });
});
