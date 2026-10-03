import { env } from 'cloudflare:workers';

export interface ServerRecord {
  name: string;
  title: string | null;
  description: string | null;
  url: string;
  host: string;
  transport: string;
  repo: string | null;
  website: string | null;
  registry_status: string | null;
  registry_updated_at: string | null;
  probed_at: string;
  status: string;
  http_status: number | null;
  auth_scheme: string | null;
  protocol_version: string | null;
  server_name: string | null;
  server_version: string | null;
  capabilities: string | null;
  init_ms: number | null;
  tools_ms: number | null;
  tool_count: number | null;
  tools_tokens: number | null;
  instructions_chars: number | null;
  toolset_hash: string | null;
  toolset_siblings: number | null;
  top_tools: string | null;
  error: string | null;
}

export interface HostRecord {
  host: string;
  servers: number;
  ok: number;
  auth: number;
  dead: number;
  unique_toolsets: number;
  median_tokens: number | null;
  probed_at: string;
}

export interface ProbeRecord {
  probed_at: string;
  status: string;
  init_ms: number | null;
  tool_count: number | null;
  tools_tokens: number | null;
}

export interface RunSummary {
  probedAt: string;
  registryEntries: number;
  registryWithRemote: number;
  probed: number;
  byStatus: Record<string, number>;
  reachable: number;
  ok: number;
  uniqueToolsets: number;
  duplicateServers: number;
  protocols: Record<string, number>;
  authSchemes: Record<string, number>;
  transports: Record<string, number>;
  toolsTokens: { median: number; p90: number; p99: number; max: number; total: number };
  toolCount: { median: number; p90: number; max: number };
  initMs: { median: number; p90: number };
  hosts: number;
  heaviest: Array<{ name: string; toolCount: number; toolsTokens: number; host: string }>;
}

function db(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

export async function latestRun(): Promise<RunSummary | null> {
  const row = await db().prepare('SELECT summary FROM runs ORDER BY probed_at DESC LIMIT 1').first<{ summary: string }>();
  return row ? (JSON.parse(row.summary) as RunSummary) : null;
}

export async function getServer(name: string): Promise<ServerRecord | null> {
  return db().prepare('SELECT * FROM servers WHERE name = ?').bind(name).first<ServerRecord>();
}

/** The registry name of the server at this URL, if any. */
export async function findByUrl(url: string): Promise<string | null> {
  const row = await db().prepare('SELECT name FROM servers WHERE url = ? OR url = ? LIMIT 1').bind(url, url.replace(/\/$/, '')).first<{ name: string }>();
  return row?.name ?? null;
}

export async function getHistory(name: string, limit = 60): Promise<ProbeRecord[]> {
  const { results } = await db()
    .prepare('SELECT probed_at, status, init_ms, tool_count, tools_tokens FROM probes WHERE name = ? ORDER BY probed_at DESC LIMIT ?')
    .bind(name, limit)
    .all<ProbeRecord>();
  return results;
}

export async function getSiblings(hash: string, except: string, limit = 12): Promise<Array<Pick<ServerRecord, 'name' | 'host' | 'status'>>> {
  const { results } = await db()
    .prepare('SELECT name, host, status FROM servers WHERE toolset_hash = ? AND name <> ? ORDER BY name LIMIT ?')
    .bind(hash, except, limit)
    .all<Pick<ServerRecord, 'name' | 'host' | 'status'>>();
  return results;
}

/** Sort keys. Directions match the indexes in schema.sql, so each page reads only its rows. */
export const SORTS = {
  tokens: { order: 'tools_tokens DESC, name', where: '', label: 'most tokens' },
  'tokens-asc': { order: 'tools_tokens ASC, name', where: 'tools_tokens IS NOT NULL', label: 'fewest tokens' },
  tools: { order: 'tool_count DESC, name', where: '', label: 'most tools' },
  latency: { order: 'init_ms ASC, name', where: 'init_ms IS NOT NULL', label: 'fastest' },
  'latency-desc': { order: 'init_ms DESC, name', where: 'init_ms IS NOT NULL', label: 'slowest' },
  name: { order: 'name', where: '', label: 'name' },
  updated: { order: 'registry_updated_at DESC, name', where: '', label: 'recently updated' }
} as const;
export type SortKey = keyof typeof SORTS;

export interface ListQuery {
  q?: string;
  status?: string;
  host?: string;
  protocol?: string;
  transport?: string;
  sort?: SortKey;
  page?: number;
  perPage?: number;
}

export const LIST_COLUMNS =
  'name, title, host, transport, status, http_status, auth_scheme, protocol_version, init_ms, tool_count, tools_tokens, toolset_siblings, registry_updated_at';
export type ListRow = Pick<
  ServerRecord,
  | 'name' | 'title' | 'host' | 'transport' | 'status' | 'http_status' | 'auth_scheme' | 'protocol_version'
  | 'init_ms' | 'tool_count' | 'tools_tokens' | 'toolset_siblings' | 'registry_updated_at'
>;

/**
 * Turns free text into an FTS5 query for the trigram tokenizer: every word of
 * three or more characters must occur somewhere, inside words too, so "deep wiki"
 * finds DeepWiki and "git copilot" finds api.githubcopilot.com. Shorter words
 * cannot be matched by trigrams and are dropped. Returns null when nothing is left.
 */
export function ftsQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.\-]+/u)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => [...t].length >= 3)
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

/**
 * Lists one page of servers. There is no COUNT(*): on the free tier every row a
 * query scans counts against the daily budget, so the page asks for one row more
 * than it shows to know whether a next page exists. Text search goes through the
 * FTS5 table, so it reads only the matching rows.
 */
export async function listServers(query: ListQuery): Promise<{ rows: ListRow[]; hasNext: boolean; page: number; perPage: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const match = query.q ? ftsQuery(query.q) : null;
  if (match) {
    where.push('servers.rowid IN (SELECT rowid FROM servers_fts WHERE servers_fts MATCH ?)');
    binds.push(match);
  }
  if (query.status === 'down') {
    where.push("status NOT IN ('ok', 'auth', 'payment')");
  } else if (query.status) {
    where.push('status = ?');
    binds.push(query.status);
  }
  if (query.host) {
    where.push('host = ?');
    binds.push(query.host);
  }
  if (query.protocol) {
    where.push('protocol_version = ?');
    binds.push(query.protocol);
  }
  if (query.transport === 'sse' || query.transport === 'streamable-http') {
    where.push('transport = ?');
    binds.push(query.transport);
  }
  const sort = SORTS[query.sort ?? 'tokens'] ?? SORTS.tokens;
  if (sort.where) where.push(sort.where);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = Math.min(200, Math.max(10, query.perPage ?? 50));
  const page = Math.min(1000, Math.max(1, query.page ?? 1));
  const { results } = await db()
    .prepare(`SELECT ${LIST_COLUMNS} FROM servers ${whereSql} ORDER BY ${sort.order} LIMIT ? OFFSET ?`)
    .bind(...binds, perPage + 1, (page - 1) * perPage)
    .all<ListRow>();
  return { rows: results.slice(0, perPage), hasNext: results.length > perPage, page, perPage };
}

export async function listHosts(limit = 300): Promise<HostRecord[]> {
  const { results } = await db().prepare('SELECT * FROM hosts ORDER BY servers DESC LIMIT ?').bind(limit).all<HostRecord>();
  return results;
}
