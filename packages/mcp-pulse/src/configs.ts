import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RemoteTransport } from './types.js';

/** One server as a client config describes it. */
export interface ConfiguredServer {
  name: string;
  /** Where it came from: file path, plus the scope inside the file when there is one. */
  source: string;
  kind: 'remote' | 'stdio';
  url?: string;
  type?: RemoteTransport;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface ConfigFile {
  path: string;
  /** The client that owns the file. */
  client: string;
  servers: ConfiguredServer[];
}

export interface DiscoverOptions {
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/** Expands ${VAR} and ${VAR:-default} the way Claude Code does in .mcp.json. */
export function expand(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    return whole;
  });
}

function expandRecord(record: Record<string, unknown> | undefined, env: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) if (typeof v === 'string') out[k] = expand(v, env);
  return out;
}

function remoteType(raw: Record<string, unknown>, url: string): RemoteTransport {
  const t = String(raw.type ?? raw.transport ?? '').toLowerCase();
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamablehttp' || t === 'streamable_http') return 'streamable-http';
  return /\/sse\/?$/.test(url) ? 'sse' : 'streamable-http';
}

/** Normalises one `{ name: {...} }` map of servers. Accepts the shapes Claude, Cursor, Windsurf and VS Code write. */
export function normalizeServers(
  map: Record<string, unknown> | undefined,
  source: string,
  env: Record<string, string | undefined> = process.env
): ConfiguredServer[] {
  if (!map || typeof map !== 'object') return [];
  const out: ConfiguredServer[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    const disabled = raw.disabled === true || raw.enabled === false;
    const url = typeof raw.url === 'string' ? expand(raw.url, env) : typeof raw.serverUrl === 'string' ? expand(raw.serverUrl, env) : undefined;
    if (url && String(raw.type ?? '').toLowerCase() !== 'stdio') {
      out.push({ name, source, kind: 'remote', url, type: remoteType(raw, url), headers: expandRecord(raw.headers as Record<string, unknown> | undefined, env), disabled });
      continue;
    }
    if (typeof raw.command === 'string') {
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string').map((a) => expand(a, env)) : [];
      out.push({
        name,
        source,
        kind: 'stdio',
        command: expand(raw.command, env),
        args,
        env: expandRecord(raw.env as Record<string, unknown> | undefined, env),
        cwd: typeof raw.cwd === 'string' ? expand(raw.cwd, env) : undefined,
        disabled
      });
    }
  }
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parses one config file of a known client. Returns null when the file is missing or not JSON. */
export async function readConfigFile(file: string, client: string, options: DiscoverOptions = {}): Promise<ConfigFile | null> {
  const env = options.env ?? process.env;
  const json = await readJson(file);
  if (!json) return null;
  const servers: ConfiguredServer[] = [];
  if (client === 'Claude Code (user)') {
    servers.push(...normalizeServers(json.mcpServers as Record<string, unknown>, `${file} (user)`, env));
    const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
    const cwd = options.cwd ?? process.cwd();
    for (const [projectPath, project] of Object.entries(projects)) {
      if (projectPath === cwd || cwd.startsWith(projectPath.replace(/\/?$/, '/'))) {
        servers.push(...normalizeServers(project.mcpServers as Record<string, unknown>, `${file} (project ${projectPath})`, env));
      }
    }
  } else if (json.servers && typeof json.servers === 'object') {
    servers.push(...normalizeServers(json.servers as Record<string, unknown>, file, env));
  } else {
    servers.push(...normalizeServers(json.mcpServers as Record<string, unknown>, file, env));
  }
  return { path: file, client, servers };
}

/** The places the common clients keep their MCP config. */
export function knownConfigPaths(options: DiscoverOptions = {}): Array<{ path: string; client: string }> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const desktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  return [
    { path: path.join(cwd, '.mcp.json'), client: 'Claude Code (project)' },
    { path: path.join(home, '.claude.json'), client: 'Claude Code (user)' },
    { path: desktop, client: 'Claude Desktop' },
    { path: path.join(cwd, '.cursor', 'mcp.json'), client: 'Cursor (project)' },
    { path: path.join(home, '.cursor', 'mcp.json'), client: 'Cursor (user)' },
    { path: path.join(cwd, '.vscode', 'mcp.json'), client: 'VS Code (workspace)' },
    { path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), client: 'Windsurf' },
    { path: path.join(home, '.gemini', 'settings.json'), client: 'Gemini CLI' }
  ];
}

/** Reads every known config file that exists. */
export async function discoverConfigs(options: DiscoverOptions = {}): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  for (const { path: file, client } of knownConfigPaths(options)) {
    const cfg = await readConfigFile(file, client, options);
    if (cfg) found.push(cfg);
  }
  return found;
}
