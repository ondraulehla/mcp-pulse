/**
 * Turns a raw probe run plus the registry snapshot into the compact files the
 * site and the badges read. Usage:
 *   node --import tsx probe/build-data.ts --in data/raw/probe-all-2026-10-03.json --registry data/raw/registry-latest.json --out data/latest
 * Writes:
 *   <out>/servers.json   one compact row per probed server
 *   <out>/summary.json   aggregates for the front page
 *   <out>/hosts.json     per-host aggregates, biggest first
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ProbeResult, RegistryEntry } from '../packages/mcptop/src/index.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    registry: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string', default: 'data/latest' }
  }
});
if (!args.in) throw new Error('--in <probe run json> is required');

interface RawRow {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse';
  host: string;
  updatedAt: string;
  status: string;
  result: ProbeResult;
  payloadHash?: string;
}

export interface ServerRow {
  name: string;
  title?: string;
  description?: string;
  url: string;
  host: string;
  transport: 'streamable-http' | 'sse';
  repo?: string;
  website?: string;
  registryStatus: string;
  registryUpdatedAt: string;
  probedAt: string;
  status: string;
  httpStatus?: number;
  authScheme?: string;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  capabilities?: string[];
  initMs?: number;
  toolsMs?: number;
  toolCount?: number;
  /** o200k_base tokens over the compact JSON of the tool definitions: the estimate, the same for every server. */
  toolsTokens?: number;
  /** Hash of the full tool payloads. The next run reuses the Claude count when it is unchanged. */
  payloadHash?: string;
  /** Exact count from the Anthropic count_tokens endpoint, tool names as published. */
  claudeTokens?: number;
  /** The same with Claude Code's mcp__<server>__ prefix on each tool name. */
  claudeTokensCc?: number;
  claudeModel?: string;
  claudeMeasuredAt?: string;
  /** Why Claude refused to count, for example a schema the API does not accept. */
  claudeError?: string;
  instructionsChars?: number;
  /** Hash of the sorted tool names and schema sizes. Equal hashes mean the same tool set. */
  toolsetHash?: string;
  /** How many other probed servers share this tool set. */
  toolsetSiblings?: number;
  topTools?: Array<{ name: string; tokens: number }>;
  error?: string;
}

const run = JSON.parse(await readFile(args.in, 'utf8')) as { probedAt: string; rows: RawRow[] };
const registryRaw = JSON.parse(await readFile(args.registry, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
const registry = new Map(registryRaw.map((r) => [r.server.name, r.server]));

const rows: ServerRow[] = run.rows.map((r) => {
  const s = registry.get(r.name);
  const res = r.result;
  const toolsetHash = res.tools?.length
    ? createHash('sha1').update(res.tools.map((t) => `${t.name}:${t.bytes}`).sort().join('|')).digest('hex').slice(0, 12)
    : undefined;
  return {
    name: r.name,
    title: s?.title,
    description: s?.description?.slice(0, 200),
    url: r.url,
    host: r.host,
    transport: r.type,
    repo: s?.repository?.url,
    website: s?.websiteUrl,
    registryStatus: r.status,
    registryUpdatedAt: r.updatedAt,
    probedAt: res.probedAt,
    status: res.status,
    httpStatus: res.httpStatus,
    authScheme: res.authScheme,
    protocolVersion: res.protocolVersion,
    serverName: res.serverInfo?.name,
    serverVersion: res.serverInfo?.version,
    capabilities: res.capabilities,
    initMs: res.latencyMs.initialize,
    toolsMs: res.latencyMs.toolsList,
    toolCount: res.toolCount,
    toolsTokens: res.toolsTokens,
    payloadHash: r.payloadHash,
    claudeTokens: res.claude?.tokens,
    claudeTokensCc: res.claude?.tokensClaudeCode,
    claudeModel: res.claude?.model,
    claudeMeasuredAt: res.claude?.measuredAt,
    claudeError: res.claude?.error,
    instructionsChars: res.instructionsChars,
    toolsetHash,
    topTools: res.tools ? [...res.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((t) => ({ name: t.name, tokens: t.tokens })) : undefined,
    error: res.status === 'ok' ? undefined : res.error?.slice(0, 160)
  };
});

const siblings = new Map<string, number>();
for (const r of rows) if (r.toolsetHash) siblings.set(r.toolsetHash, (siblings.get(r.toolsetHash) ?? 0) + 1);
for (const r of rows) if (r.toolsetHash) r.toolsetSiblings = (siblings.get(r.toolsetHash) ?? 1) - 1;

const count = <T>(xs: T[], key: (x: T) => string | undefined) => {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = key(x) ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

const ok = rows.filter((r) => r.status === 'ok');
const tokens = ok.map((r) => r.toolsTokens ?? 0);
const counted = ok.filter((r) => r.claudeTokens != null);
const claude = counted.map((r) => r.claudeTokens!);
const claudeCc = counted.map((r) => r.claudeTokensCc ?? r.claudeTokens!);
const claudeModel = counted[0]?.claudeModel;
const uniqueToolsets = new Set(ok.map((r) => r.toolsetHash)).size;
/** Ranks by the exact Claude count when the run has one, else by the estimate. */
const weight = (r: ServerRow) => r.claudeTokens ?? (counted.length ? -1 : (r.toolsTokens ?? 0));
const summary = {
  probedAt: run.probedAt,
  registryEntries: registryRaw.length,
  registryWithRemote: registryRaw.filter((r) => r.server.remotes?.length).length,
  probed: rows.length,
  byStatus: count(rows, (r) => r.status),
  reachable: ok.length + rows.filter((r) => r.status === 'auth' || r.status === 'payment' || r.status === 'newer_protocol').length,
  ok: ok.length,
  uniqueToolsets,
  duplicateServers: ok.length - uniqueToolsets,
  protocols: count(ok, (r) => r.protocolVersion),
  authSchemes: count(rows.filter((r) => r.status === 'auth'), (r) => r.authScheme ?? 'none'),
  transports: count(rows, (r) => r.transport),
  toolsTokens: { median: quantile(tokens, 0.5), p90: quantile(tokens, 0.9), p99: quantile(tokens, 0.99), max: Math.max(0, ...tokens), total: tokens.reduce((a, b) => a + b, 0) },
  claudeTokens: counted.length
    ? {
        model: claudeModel,
        counted: counted.length,
        refused: ok.filter((r) => r.claudeError).length,
        median: quantile(claude, 0.5), p90: quantile(claude, 0.9), p99: quantile(claude, 0.99), max: Math.max(0, ...claude), total: claude.reduce((a, b) => a + b, 0),
        claudeCode: { median: quantile(claudeCc, 0.5), p90: quantile(claudeCc, 0.9), p99: quantile(claudeCc, 0.99), max: Math.max(0, ...claudeCc), total: claudeCc.reduce((a, b) => a + b, 0) },
        /** Exact count divided by the estimate, over the counted servers. */
        ratioToEstimate: { median: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.5), p10: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.1), p90: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.9) }
      }
    : undefined,
  toolCount: { median: quantile(ok.map((r) => r.toolCount ?? 0), 0.5), p90: quantile(ok.map((r) => r.toolCount ?? 0), 0.9), max: Math.max(0, ...ok.map((r) => r.toolCount ?? 0)) },
  initMs: { median: quantile(ok.map((r) => r.initMs ?? 0), 0.5), p90: quantile(ok.map((r) => r.initMs ?? 0), 0.9) },
  hosts: new Set(rows.map((r) => r.host)).size,
  heaviest: [...ok].sort((a, b) => weight(b) - weight(a)).slice(0, 20).map((r) => ({ name: r.name, toolCount: r.toolCount, toolsTokens: r.toolsTokens, claudeTokens: r.claudeTokens, claudeTokensCc: r.claudeTokensCc, host: r.host }))
};

const hostMap = new Map<string, ServerRow[]>();
for (const r of rows) (hostMap.get(r.host) ?? hostMap.set(r.host, []).get(r.host)!).push(r);
const hosts = [...hostMap.entries()]
  .map(([host, list]) => ({
    host,
    servers: list.length,
    byStatus: count(list, (r) => r.status),
    uniqueToolsets: new Set(list.filter((r) => r.toolsetHash).map((r) => r.toolsetHash)).size,
    medianTokens: quantile(list.filter((r) => r.status === 'ok').map((r) => r.toolsTokens ?? 0), 0.5)
  }))
  .sort((a, b) => b.servers - a.servers);

await mkdir(args.out, { recursive: true });
await writeFile(`${args.out}/servers.json`, JSON.stringify(rows));
await writeFile(`${args.out}/summary.json`, JSON.stringify(summary, null, 2));
await writeFile(`${args.out}/hosts.json`, JSON.stringify(hosts));
console.log(JSON.stringify({ ...summary, heaviest: summary.heaviest.slice(0, 5) }, null, 2));
console.error(`wrote ${rows.length} rows to ${args.out}/`);
