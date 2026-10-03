/**
 * Turns data/latest/*.json into one SQL file for D1. Usage:
 *   node --import tsx probe/to-sql.ts --in data/latest --out data/latest/import.sql
 * Then:
 *   npx wrangler d1 execute mcp-pulse --remote --file=data/latest/import.sql
 * The file uses INSERT OR REPLACE, so it is safe to run again.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ServerRow } from './build-data.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/latest' },
    out: { type: 'string', default: 'data/latest/import.sql' },
    'rows-per-insert': { type: 'string', default: '40' }
  }
});
const rowsPerInsert = Number(args['rows-per-insert']);

const servers = JSON.parse(await readFile(`${args.in}/servers.json`, 'utf8')) as ServerRow[];
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
const hostRows = hosts.map((h) => [h.host, h.servers, h.byStatus.ok ?? 0, (h.byStatus.auth ?? 0) + (h.byStatus.payment ?? 0), dead(h.byStatus), h.uniqueToolsets, h.medianTokens, summary.probedAt]);

const statements = [
  `INSERT OR REPLACE INTO runs (probed_at, summary) VALUES (${lit(summary.probedAt)}, ${lit(JSON.stringify(summary))});`,
  ...multiInsert('servers', serverColumns, serverRows),
  ...multiInsert('probes', ['name', 'probed_at', 'status', 'init_ms', 'tool_count', 'tools_tokens'], probeRows, 'INSERT OR IGNORE'),
  'DELETE FROM hosts;',
  ...multiInsert('hosts', ['host', 'servers', 'ok', 'auth', 'dead', 'unique_toolsets', 'median_tokens', 'probed_at'], hostRows),
  // Keep 90 days of history so the free tier database stays small.
  `DELETE FROM probes WHERE probed_at < ${lit(new Date(Date.now() - 90 * 86_400_000).toISOString())};`
];
await writeFile(args.out, statements.join('\n') + '\n');
console.error(`wrote ${statements.length} statements for ${servers.length} servers and ${hosts.length} hosts to ${args.out}`);
