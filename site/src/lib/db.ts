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
  /** Exact count from the Anthropic count_tokens endpoint, names as published. */
  claude_tokens: number | null;
  /** The same with Claude Code's mcp__<server>__ prefix. */
  claude_tokens_cc: number | null;
  claude_model: string | null;
  claude_measured_at: string | null;
  claude_error: string | null;
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
  claude_tokens: number | null;
}

export interface TokenStats {
  median: number;
  p90: number;
  p99: number;
  max: number;
  total: number;
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
  /** o200k_base estimate. */
  toolsTokens: TokenStats;
  /** Exact counts, present once a run had an API key. */
  claudeTokens?: TokenStats & {
    model?: string;
    counted: number;
    refused: number;
    claudeCode: TokenStats;
    ratioToEstimate: { median: number; p10: number; p90: number };
  };
  toolCount: { median: number; p90: number; max: number };
  initMs: { median: number; p90: number };
  hosts: number;
  heaviest: Array<{ name: string; toolCount: number; toolsTokens: number; claudeTokens?: number; claudeTokensCc?: number; host: string }>;
}

/** The headline numbers: exact Claude counts when the run has them, else the estimate. */
export function headline(run: RunSummary): { stats: TokenStats; exact: boolean; model?: string } {
  return run.claudeTokens ? { stats: run.claudeTokens, exact: true, model: run.claudeTokens.model } : { stats: run.toolsTokens, exact: false };
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
  const bare = url.replace(/\/$/, '');
  const row = await db()
    .prepare('SELECT name FROM servers WHERE url IN (?, ?, ?, ?) LIMIT 1')
    .bind(url, bare, bare + '/', bare.replace(/^http:/, 'https:'))
    .first<{ name: string }>();
  return row?.name ?? null;
}

/** Registry servers on the same host, for a URL that is not registered as is. */
export async function serversOnHost(host: string, limit = 8): Promise<Array<Pick<ServerRecord, 'name' | 'url' | 'status'>>> {
  const { results } = await db()
    .prepare('SELECT name, url, status FROM servers WHERE host = ? ORDER BY name LIMIT ?')
    .bind(host, limit)
    .all<Pick<ServerRecord, 'name' | 'url' | 'status'>>();
  return results;
}

export async function getHistory(name: string, limit = 60): Promise<ProbeRecord[]> {
  const { results } = await db()
    .prepare('SELECT probed_at, status, init_ms, tool_count, tools_tokens, claude_tokens FROM probes WHERE name = ? ORDER BY probed_at DESC LIMIT ?')
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

/**
 * Sort keys. Each matches an index in schema.sql. The opposite direction reads
 * the same index backwards, so its name tie-break is reversed too.
 */
export const SORTS = {
  claude: { order: 'claude_tokens DESC, name', where: '', label: 'Claude: most tokens' },
  'claude-asc': { order: 'claude_tokens ASC, name DESC', where: 'claude_tokens IS NOT NULL', label: 'Claude: fewest tokens' },
  tokens: { order: 'tools_tokens DESC, name', where: '', label: 'estimate: largest' },
  'tokens-asc': { order: 'tools_tokens ASC, name DESC', where: 'tools_tokens IS NOT NULL', label: 'estimate: smallest' },
  tools: { order: 'tool_count DESC, name', where: '', label: 'tools: most' },
  'tools-asc': { order: 'tool_count ASC, name DESC', where: 'tool_count IS NOT NULL', label: 'tools: fewest' },
  latency: { order: 'init_ms ASC, name', where: 'init_ms IS NOT NULL', label: 'init: fastest' },
  'latency-desc': { order: 'init_ms DESC, name DESC', where: 'init_ms IS NOT NULL', label: 'init: slowest' },
  name: { order: 'name', where: '', label: 'name A to Z' },
  'name-desc': { order: 'name DESC', where: '', label: 'name Z to A' },
  status: { order: 'status, name', where: '', label: 'result A to Z' },
  'status-desc': { order: 'status DESC, name DESC', where: '', label: 'result Z to A' },
  protocol: { order: 'protocol_version ASC, name', where: 'protocol_version IS NOT NULL', label: 'protocol: oldest' },
  'protocol-desc': { order: 'protocol_version DESC, name DESC', where: 'protocol_version IS NOT NULL', label: 'protocol: newest' },
  host: { order: 'host, name', where: '', label: 'host A to Z' },
  'host-desc': { order: 'host DESC, name DESC', where: '', label: 'host Z to A' },
  updated: { order: 'registry_updated_at DESC, name', where: '', label: 'updated: newest first' }
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
  'name, title, host, transport, status, http_status, auth_scheme, protocol_version, init_ms, tool_count, tools_tokens, claude_tokens, claude_tokens_cc, toolset_siblings, registry_updated_at';
export type ListRow = Pick<
  ServerRecord,
  | 'name' | 'title' | 'host' | 'transport' | 'status' | 'http_status' | 'auth_scheme' | 'protocol_version'
  | 'init_ms' | 'tool_count' | 'tools_tokens' | 'claude_tokens' | 'claude_tokens_cc' | 'toolset_siblings' | 'registry_updated_at'
>;
export const DEFAULT_SORT: SortKey = 'claude';

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
    where.push("status NOT IN ('ok', 'auth', 'payment', 'newer_protocol')");
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
  const sort = SORTS[query.sort ?? DEFAULT_SORT] ?? SORTS[DEFAULT_SORT];
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

/** The highest rowid in servers. Sitemap chunks are rowid windows, so each chunk reads only its own rows. */
export async function maxServerRowid(): Promise<number> {
  const row = await db().prepare('SELECT max(rowid) AS m FROM servers').first<{ m: number | null }>();
  return row?.m ?? 0;
}

/** Servers in one rowid window, for a sitemap chunk. */
export async function serversInRowidWindow(from: number, to: number): Promise<Array<{ name: string; probed_at: string }>> {
  const { results } = await db()
    .prepare('SELECT name, probed_at FROM servers WHERE rowid > ? AND rowid <= ? ORDER BY rowid')
    .bind(from, to)
    .all<{ name: string; probed_at: string }>();
  return results;
}

export async function listHosts(limit = 300): Promise<HostRecord[]> {
  const { results } = await db().prepare('SELECT * FROM hosts ORDER BY servers DESC LIMIT ?').bind(limit).all<HostRecord>();
  return results;
}
