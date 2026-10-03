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
import { parseArgs } from 'node:util';
import type { ServerRow } from './build-data.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest/import.sql' },
    previous: { type: 'string' },
    'rows-per-insert': { type: 'string', default: '40' }
  }
});
const rowsPerInsert = Number(args['rows-per-insert']);

const allServers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
const previous = args.previous ? ((JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[])) : null;

/** What counts as a change: everything except the probe timestamp. */
function fingerprint(s: ServerRow): string {
  const { probedAt: _probedAt, ...rest } = s;
  return JSON.stringify(rest);
}
const previousByName = new Map((previous ?? []).map((s) => [s.name, fingerprint(s)]));
const servers = previous ? allServers.filter((s) => previousByName.get(s.name) !== fingerprint(s)) : allServers;
const removed = previous ? [...previousByName.keys()].filter((name) => !allServers.some((s) => s.name === name)) : [];
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

function multiInsert(table: string, columns: string[], rows: Value[][], verb = 'INSERT OR REPLACE'): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += rowsPerInsert) {
    const chunk = rows.slice(i, i + rowsPerInsert).map((r) => `(${r.map(lit).join(',')})`);
    out.push(`${verb} INTO ${table} (${columns.join(',')}) VALUES\n${chunk.join(',\n')};`);
  }
  return out;
}

const serverColumns = [
  'name', 'title', 'description', 'url', 'host', 'transport', 'repo', 'website', 'registry_status', 'registry_updated_at',
  'probed_at', 'status', 'http_status', 'auth_scheme', 'protocol_version', 'server_name', 'server_version', 'capabilities',
  'init_ms', 'tools_ms', 'tool_count', 'tools_tokens', 'instructions_chars', 'toolset_hash', 'toolset_siblings', 'top_tools', 'error'
];
const serverRows = servers.map((s) => [
  s.name, s.title, s.description, s.url, s.host, s.transport, s.repo, s.website, s.registryStatus, s.registryUpdatedAt,
  s.probedAt, s.status, s.httpStatus, s.authScheme, s.protocolVersion, s.serverName, s.serverVersion, s.capabilities ? JSON.stringify(s.capabilities) : null,
  s.initMs, s.toolsMs, s.toolCount, s.toolsTokens, s.instructionsChars, s.toolsetHash, s.toolsetSiblings, s.topTools ? JSON.stringify(s.topTools) : null, s.error
]);
const probeRows = servers.map((s) => [s.name, s.probedAt, s.status, s.initMs, s.toolCount, s.toolsTokens]);
const dead = (b: Record<string, number>) => Object.entries(b).filter(([k]) => !['ok', 'auth', 'payment'].includes(k)).reduce((a, [, n]) => a + n, 0);
const changedHosts = new Set(servers.map((s) => s.host));
const hostRows = hosts
  .filter((h) => !previous || changedHosts.has(h.host))
  .map((h) => [h.host, h.servers, h.byStatus.ok ?? 0, (h.byStatus.auth ?? 0) + (h.byStatus.payment ?? 0), dead(h.byStatus), h.uniqueToolsets, h.medianTokens, summary.probedAt]);

const statements = [
  `INSERT OR REPLACE INTO runs (probed_at, summary) VALUES (${lit(summary.probedAt)}, ${lit(JSON.stringify(summary))});`,
  ...multiInsert('servers', serverColumns, serverRows),
  ...multiInsert('probes', ['name', 'probed_at', 'status', 'init_ms', 'tool_count', 'tools_tokens'], probeRows, 'INSERT OR IGNORE'),
  ...(removed.length ? [`DELETE FROM servers WHERE name IN (${removed.map(lit).join(',')});`] : []),
  ...(previous ? [] : ['DELETE FROM hosts;']),
  ...multiInsert('hosts', ['host', 'servers', 'ok', 'auth', 'dead', 'unique_toolsets', 'median_tokens', 'probed_at'], hostRows),
  // Keep 90 days of history so the free tier database stays small.
  `DELETE FROM probes WHERE probed_at < ${lit(new Date(Date.now() - 90 * 86_400_000).toISOString())};`
];
await writeFile(args.out, statements.join('\n') + '\n');
console.error(
  previous
    ? `wrote ${statements.length} statements: ${servers.length} of ${allServers.length} servers changed, ${removed.length} removed, ${hostRows.length} hosts touched, to ${args.out}`
    : `wrote ${statements.length} statements for ${servers.length} servers and ${hosts.length} hosts to ${args.out}`
);
