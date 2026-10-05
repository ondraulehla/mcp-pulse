/**
 * Turns data/latest/*.json into one SQL file for D1. Usage:
 *   node --import tsx probe/to-sql.ts --in data/latest --out data/latest/import.sql [--previous old/servers.json]
 * Then:
 *   npx wrangler d1 execute mcp-pulse --remote --file=data/latest/import.sql
 * The file uses INSERT OR REPLACE, so it is safe to run again.
 *
 * With --previous, only servers whose row changed since that run are written, and
 * a history row is added only for them. D1 counts every index entry as a row
 * written, and the free tier allows 100 000 a day, so a full rewrite of 24 000
 * servers with ten indexes would not fit. probed_at of an unchanged server stays
 * at the last change; the run date on the board comes from the runs table.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ServerRow } from './build-data.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest/import.sql' },
    previous: { type: 'string' },
    /** hosts.json of the previous run. Only host rows that changed are written. */
    'previous-hosts': { type: 'string' },
    'rows-per-insert': { type: 'string', default: '40' }
  }
});
const rowsPerInsert = Number(args['rows-per-insert']);

const allServers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
const previous = args.previous ? ((JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[])) : null;

/**
 * What counts as a change: everything except the probe timestamp and the two
 * latencies, which differ on every run and would turn every row into a write.
 */
function fingerprint(s: ServerRow): string {
  const { probedAt: _probedAt, initMs: _initMs, toolsMs: _toolsMs, payloadHash: _payloadHash, ...rest } = s;
  return JSON.stringify(rest);
}
const previousByName = new Map((previous ?? []).map((s) => [s.name, fingerprint(s)]));
const servers = previous ? allServers.filter((s) => previousByName.get(s.name) !== fingerprint(s)) : allServers;
const currentNames = new Set(allServers.map((s) => s.name));
const removed = previous ? [...previousByName.keys()].filter((name) => !currentNames.has(name)) : [];
const summary = JSON.parse(await readFile(`${args.in}/summary.json`, 'utf8')) as { probedAt: string };
const hosts = JSON.parse(await readFile(`${args.in}/hosts.json`, 'utf8')) as Array<{
  host: string; servers: number; byStatus: Record<string, number>; uniqueToolsets: number; medianTokens: number;
}>;

type Value = string | number | boolean | null | undefined | string[] | object;
function lit(v: Value): string {
  if (v === undefined || v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function multiInsert(table: string, columns: string[], rows: Value[][], verb = 'INSERT OR REPLACE', suffix = ''): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += rowsPerInsert) {
    const chunk = rows.slice(i, i + rowsPerInsert).map((r) => `(${r.map(lit).join(',')})`);
    out.push(`${verb} INTO ${table} (${columns.join(',')}) VALUES\n${chunk.join(',\n')}${suffix};`);
  }
  return out;
}

/** An upsert fires the UPDATE trigger that keeps the FTS index in step; REPLACE would not. */
function upsertSuffix(key: string, columns: string[]): string {
  return `\nON CONFLICT(${key}) DO UPDATE SET ${columns.filter((c) => c !== key).map((c) => `${c}=excluded.${c}`).join(', ')}`;
}

const serverColumns = [
  'name', 'title', 'description', 'url', 'host', 'transport', 'repo', 'website', 'registry_status', 'registry_updated_at',
  'probed_at', 'status', 'http_status', 'auth_scheme', 'protocol_version', 'server_name', 'server_version', 'capabilities',
  'init_ms', 'tools_ms', 'tool_count', 'tools_tokens', 'instructions_chars', 'toolset_hash', 'toolset_siblings', 'top_tools', 'error',
  'claude_model', 'claude_tokens', 'claude_tokens_cc', 'claude_measured_at', 'claude_error'
];
function serverValues(s: ServerRow): Value[] {
  return [
    s.name, s.title, s.description, s.url, s.host, s.transport, s.repo, s.website, s.registryStatus, s.registryUpdatedAt,
    s.probedAt, s.status, s.httpStatus, s.authScheme, s.protocolVersion, s.serverName, s.serverVersion, s.capabilities ? JSON.stringify(s.capabilities) : null,
    s.initMs, s.toolsMs, s.toolCount, s.toolsTokens, s.instructionsChars, s.toolsetHash, s.toolsetSiblings, s.topTools ? JSON.stringify(s.topTools) : null, s.error,
    s.claudeModel, s.claudeTokens, s.claudeTokensCc, s.claudeMeasuredAt, s.claudeError
  ];
}
const previousRows = new Map((previous ?? []).map((s) => [s.name, s]));
const newServers = servers.filter((s) => !previousRows.has(s.name));
const changedServers = servers.filter((s) => previousRows.has(s.name));

/**
 * SQLite rewrites every index whose column is in the SET list, whether the
 * value changed or not, and D1 counts each index entry as a row written. So a
 * changed server gets an UPDATE that names only the columns that differ from
 * the previous run. Rows with the same set of changed columns share one
 * statement through UPDATE ... FROM (VALUES ...).
 */
function narrowUpdates(rows: ServerRow[]): string[] {
  const groups = new Map<string, { columns: string[]; values: Value[][] }>();
  for (const s of rows) {
    const before = serverValues(previousRows.get(s.name)!);
    const after = serverValues(s);
    const changed = serverColumns.filter((c, i) => c !== 'name' && lit(before[i]) !== lit(after[i]));
    if (!changed.length) continue;
    const key = changed.join(',');
    const g = groups.get(key) ?? groups.set(key, { columns: changed, values: [] }).get(key)!;
    g.values.push([s.name, ...changed.map((c) => after[serverColumns.indexOf(c)])]);
  }
  const out: string[] = [];
  for (const { columns, values } of groups.values()) {
    const cols = ['name', ...columns].map((c) => `c_${c}`);
    for (let i = 0; i < values.length; i += rowsPerInsert) {
      const chunk = values.slice(i, i + rowsPerInsert).map((r) => `(${r.map(lit).join(',')})`);
      // A CTE with a column list is the one form of a named VALUES table that SQLite accepts.
      out.push(`WITH v(${cols.join(',')}) AS (VALUES\n${chunk.join(',\n')})\nUPDATE servers SET ${columns.map((c) => `${c}=v.c_${c}`).join(', ')} FROM v WHERE servers.name = v.c_name;`);
    }
  }
  return out;
}
const serverStatements = [
  ...multiInsert('servers', serverColumns, newServers.map(serverValues), 'INSERT', upsertSuffix('name', serverColumns)),
  ...narrowUpdates(changedServers)
];
const probeRows = servers.map((s) => [s.name, s.probedAt, s.status, s.initMs, s.toolCount, s.toolsTokens, s.claudeTokens]);
const dead = (b: Record<string, number>) => Object.entries(b).filter(([k]) => !['ok', 'auth', 'payment', 'newer_protocol'].includes(k)).reduce((a, [, n]) => a + n, 0);
const changedHosts = new Set(servers.map((s) => s.host));
const previousHosts = args['previous-hosts'] && existsSync(args['previous-hosts'])
  ? new Map((JSON.parse(await readFile(args['previous-hosts'], 'utf8')) as typeof hosts).map((h) => [h.host, JSON.stringify(h)]))
  : null;
const hostRows = hosts
  .filter((h) => !previous || changedHosts.has(h.host))
  .filter((h) => !previousHosts || previousHosts.get(h.host) !== JSON.stringify(h))
  .map((h) => [h.host, h.servers, h.byStatus.ok ?? 0, (h.byStatus.auth ?? 0) + (h.byStatus.payment ?? 0) + (h.byStatus.newer_protocol ?? 0), dead(h.byStatus), h.uniqueToolsets, h.medianTokens, summary.probedAt]);

const statements = [
  `INSERT OR REPLACE INTO runs (probed_at, summary) VALUES (${lit(summary.probedAt)}, ${lit(JSON.stringify(summary))});`,
  ...serverStatements,
  ...multiInsert('probes', ['name', 'probed_at', 'status', 'init_ms', 'tool_count', 'tools_tokens', 'claude_tokens'], probeRows, 'INSERT OR IGNORE'),
  ...(removed.length ? [`DELETE FROM servers WHERE name IN (${removed.map(lit).join(',')});`] : []),
  ...(previous ? [] : ['DELETE FROM hosts;']),
  ...multiInsert('hosts', ['host', 'servers', 'ok', 'auth', 'dead', 'unique_toolsets', 'median_tokens', 'probed_at'], hostRows),
  // Keep 90 days of history so the free tier database stays small.
  `DELETE FROM probes WHERE probed_at < ${lit(new Date(Date.now() - 90 * 86_400_000).toISOString())};`
];
await writeFile(args.out, statements.join('\n') + '\n');
await writeFile(`${args.in}/changed.json`, JSON.stringify({ changed: servers.map((s) => s.name), removed }));
console.error(
  previous
    ? `wrote ${statements.length} statements: ${newServers.length} new and ${changedServers.length} changed of ${allServers.length} servers, ${removed.length} removed, ${hostRows.length} hosts touched, to ${args.out}`
    : `wrote ${statements.length} statements for ${servers.length} servers and ${hosts.length} hosts to ${args.out}`
);
