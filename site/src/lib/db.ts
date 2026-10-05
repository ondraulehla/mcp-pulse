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

type Dir = 'ASC' | 'DESC';
interface SortSpec {
  /** The sort column, or null when the sort is by name alone. */
  col: string | null;
  dir: Dir;
  /** Direction of the name tie-break; the reverse of a sort reads its index backwards, so the name flips too. */
  nameDir: Dir;
  where: string;
  label: string;
}
const sortSpec = (col: string | null, dir: Dir, nameDir: Dir, where: string, label: string): SortSpec => ({ col, dir, nameDir, where, label });

/**
 * Sort keys. Each matches an index in schema.sql. The opposite direction reads
 * the same index backwards, so its name tie-break is reversed too.
 */
export const SORTS = {
  claude: sortSpec('claude_tokens', 'DESC', 'ASC', '', 'Claude: most tokens'),
  'claude-asc': sortSpec('claude_tokens', 'ASC', 'DESC', 'claude_tokens IS NOT NULL', 'Claude: fewest tokens'),
  tokens: sortSpec('tools_tokens', 'DESC', 'ASC', '', 'estimate: largest'),
  'tokens-asc': sortSpec('tools_tokens', 'ASC', 'DESC', 'tools_tokens IS NOT NULL', 'estimate: smallest'),
  tools: sortSpec('tool_count', 'DESC', 'ASC', '', 'tools: most'),
  'tools-asc': sortSpec('tool_count', 'ASC', 'DESC', 'tool_count IS NOT NULL', 'tools: fewest'),
  latency: sortSpec('init_ms', 'ASC', 'ASC', 'init_ms IS NOT NULL', 'init: fastest'),
  'latency-desc': sortSpec('init_ms', 'DESC', 'DESC', 'init_ms IS NOT NULL', 'init: slowest'),
  name: sortSpec(null, 'ASC', 'ASC', '', 'name A to Z'),
  'name-desc': sortSpec(null, 'DESC', 'DESC', '', 'name Z to A'),
  status: sortSpec('status', 'ASC', 'ASC', '', 'result A to Z'),
  'status-desc': sortSpec('status', 'DESC', 'DESC', '', 'result Z to A'),
  protocol: sortSpec('protocol_version', 'ASC', 'ASC', 'protocol_version IS NOT NULL', 'protocol: oldest'),
  'protocol-desc': sortSpec('protocol_version', 'DESC', 'DESC', 'protocol_version IS NOT NULL', 'protocol: newest'),
  host: sortSpec('host', 'ASC', 'ASC', '', 'host A to Z'),
  'host-desc': sortSpec('host', 'DESC', 'DESC', '', 'host Z to A'),
  updated: sortSpec('registry_updated_at', 'DESC', 'ASC', '', 'updated: newest first')
} as const satisfies Record<string, SortSpec>;
export type SortKey = keyof typeof SORTS;
export const DEFAULT_SORT: SortKey = 'claude';

/** ORDER BY for a sort, forwards or (for a page before the cursor) backwards. */
function orderBy(sort: SortSpec, reverse = false): string {
  const flip = (d: Dir): Dir => (reverse ? (d === 'ASC' ? 'DESC' : 'ASC') : d);
  return sort.col ? `${sort.col} ${flip(sort.dir)}, name ${flip(sort.nameDir)}` : `name ${flip(sort.dir)}`;
}

/** A position in a sorted list: the sort value and the name of the row on the edge. */
export interface Cursor {
  value: string | number | null;
  name: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify([c.value, c.name])))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(text: string | null | undefined): Cursor | null {
  if (!text) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - (text.length % 4)) % 4);
    const parsed = JSON.parse(decodeURIComponent(escape(atob(padded)))) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string') return null;
    const value = parsed[0];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') return null;
    return { value, name: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * The rows after (or, going back, before) a cursor in this sort. SQLite puts
 * NULL first in ASC and last in DESC; the ascending sorts exclude NULL through
 * their `where`, the descending ones keep it at the end.
 */
function cursorCondition(sort: SortSpec, cursor: Cursor, back: boolean): { sql: string; binds: unknown[] } {
  const after = (d: Dir) => (back ? d === 'ASC' : d === 'DESC') ? '<' : '>';
  const nameOp = after(sort.nameDir);
  if (!sort.col) return { sql: `name ${after(sort.dir)} ?`, binds: [cursor.name] };
  const op = after(sort.dir);
  if (cursor.value === null) {
    // Inside the NULL tail of a descending sort: by name within it; going back, the non-null rows come first.
    return back
      ? { sql: `(${sort.col} IS NOT NULL OR (${sort.col} IS NULL AND name ${nameOp} ?))`, binds: [cursor.name] }
      : { sql: `(${sort.col} IS NULL AND name ${nameOp} ?)`, binds: [cursor.name] };
  }
  const nullTail = sort.dir === 'DESC' && !back ? ` OR ${sort.col} IS NULL` : '';
  return {
    sql: `(${sort.col} ${op} ?${nullTail} OR (${sort.col} = ? AND name ${nameOp} ?))`,
    binds: [cursor.value, cursor.value, cursor.name]
  };
}

/** Page numbers go this far by OFFSET (at most 1 000 rows read); beyond it the list moves by cursor. */
export const MAX_NUMBERED_PAGE = 20;

export interface ListQuery {
  q?: string;
  status?: string;
  host?: string;
  protocol?: string;
  transport?: string;
  sort?: SortKey;
  /** Page number, honoured up to MAX_NUMBERED_PAGE when there is no cursor. */
  page?: number;
  perPage?: number;
  /** Continue from this position instead of counting pages. */
  cursor?: Cursor | null;
  /** With a cursor: the page before it instead of the page after it. */
  back?: boolean;
}

export const LIST_COLUMNS =
  'name, title, host, transport, status, http_status, auth_scheme, protocol_version, init_ms, tool_count, tools_tokens, claude_tokens, claude_tokens_cc, toolset_siblings, registry_updated_at';
export type ListRow = Pick<
  ServerRecord,
  | 'name' | 'title' | 'host' | 'transport' | 'status' | 'http_status' | 'auth_scheme' | 'protocol_version'
  | 'init_ms' | 'tool_count' | 'tools_tokens' | 'claude_tokens' | 'claude_tokens_cc' | 'toolset_siblings' | 'registry_updated_at'
>;

export interface ListResult {
  rows: ListRow[];
  hasNext: boolean;
  hasPrev: boolean;
  page: number;
  perPage: number;
  /** Position after the last row, for the next page. */
  nextCursor: Cursor | null;
  /** Position before the first row, for the previous page. */
  prevCursor: Cursor | null;
}

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
 * FTS5 table, so it reads only the matching rows. Page numbers use OFFSET, which
 * reads every row it skips, so they stop at MAX_NUMBERED_PAGE; from there the
 * list continues by cursor and a page costs its own rows only.
 */
export async function listServers(query: ListQuery): Promise<ListResult> {
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
  const perPage = Math.min(200, Math.max(10, query.perPage ?? 50));
  const cursor = query.cursor ?? null;
  const back = Boolean(cursor && query.back);
  const page = cursor ? Math.max(1, query.page ?? 1) : Math.min(MAX_NUMBERED_PAGE, Math.max(1, query.page ?? 1));
  if (cursor) {
    const c = cursorCondition(sort, cursor, back);
    where.push(c.sql);
    binds.push(...c.binds);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = cursor ? 0 : (page - 1) * perPage;
  const { results } = await db()
    .prepare(`SELECT ${LIST_COLUMNS} FROM servers ${whereSql} ORDER BY ${orderBy(sort, back)} LIMIT ? OFFSET ?`)
    .bind(...binds, perPage + 1, offset)
    .all<ListRow>();
  const more = results.length > perPage;
  const rows = results.slice(0, perPage);
  if (back) rows.reverse();
  const edge = (row: ListRow): Cursor => ({ value: sort.col ? ((row as unknown as Record<string, string | number | null>)[sort.col] ?? null) : null, name: row.name });
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    rows,
    hasNext: back ? true : more,
    hasPrev: back ? more : page > 1 || cursor !== null,
    page,
    perPage,
    nextCursor: last ? edge(last) : null,
    prevCursor: first ? edge(first) : null
  };
}

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
