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
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GATED_STATUSES } from '../packages/mcpcost/src/index.js';
import type { ProbeResult, RegistryEntry } from '../packages/mcpcost/src/index.js';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    registry: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string', default: 'data/latest' },
    /** servers.json of the previous run, for the list of what changed since then and for stdio rows not probed today. */
    previous: { type: 'string' },
    /** A stdio run file from probe/stdio-run.ts: package servers probed in containers. */
    stdio: { type: 'string' },
    /** Import even when far fewer servers answered than last time. */
    force: { type: 'boolean', default: false }
  }
});
if (!args.in) throw new Error('--in <probe run json> is required');

interface RawRow {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse' | 'stdio';
  host: string;
  updatedAt: string;
  status: string;
  result: ProbeResult;
  payloadHash?: string;
}

interface StdioRow {
  name: string;
  kind: 'npm' | 'pypi';
  identifier: string;
  version?: string;
  status: string;
  result?: ProbeResult;
  error?: string;
  payloadHash?: string;
  installMs?: number;
}

export interface ServerRow {
  name: string;
  title?: string;
  description?: string;
  url: string;
  host: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
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
  /** Exact count from the Gemini countTokens endpoint. */
  geminiTokens?: number;
  geminiModel?: string;
  geminiMeasuredAt?: string;
  geminiError?: string;
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
const registryMeta = new Map(registryRaw.map((r) => [r.server.name, r._meta['io.modelcontextprotocol.registry/official']]));

/**
 * Package servers: the stdio run probes one seventh of them a day, in
 * containers. Today's rows come from the run file; the rest keep their row
 * from the previous run while the registry still lists them.
 */
const stdioFile = args.stdio && existsSync(args.stdio) ? (JSON.parse(await readFile(args.stdio, 'utf8')) as { probedAt: string; rows: StdioRow[] }) : null;
const stdioRows: RawRow[] = (stdioFile?.rows ?? []).map((r) => {
  const kind = r.kind ?? 'npm';
  const host = kind === 'npm' ? 'npmjs.com' : 'pypi.org';
  const url = kind === 'npm' ? `npm:${r.identifier}${r.version ? `@${r.version}` : ''}` : `pypi:${r.identifier}${r.version ? `==${r.version}` : ''}`;
  const result: ProbeResult = r.result ?? { url, transport: 'stdio', probedAt: stdioFile!.probedAt, status: r.status as ProbeResult['status'], latencyMs: {}, error: r.error };
  result.url = url;
  result.transport = 'stdio';
  result.status = r.status as ProbeResult['status'];
  if (r.status !== 'ok' && r.error && !result.error) result.error = r.error;
  const meta = registryMeta.get(r.name);
  return { name: r.name, url, type: 'stdio', host, updatedAt: meta?.updatedAt ?? '', status: meta?.status ?? 'active', result, payloadHash: r.payloadHash };
});
const probedNow = new Set([...run.rows, ...stdioRows].map((r) => r.name));
const previousForCarry = args.previous && existsSync(args.previous) ? (JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[]) : [];
const carried: ServerRow[] = previousForCarry.filter((r) => r.transport === 'stdio' && !probedNow.has(r.name) && registry.has(r.name));

const rows: ServerRow[] = [...run.rows, ...stdioRows].map((r) => {
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
    geminiTokens: res.gemini?.tokens,
    geminiModel: res.gemini?.model,
    geminiMeasuredAt: res.gemini?.measuredAt,
    geminiError: res.gemini?.error,
    instructionsChars: res.instructionsChars,
    toolsetHash,
    topTools: res.tools ? [...res.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((t) => ({ name: t.name, tokens: t.tokens })) : undefined,
    error: res.status === 'ok' ? undefined : res.error?.slice(0, 160)
  };
});

rows.push(...carried);

/**
 * A broken runner looks like a mass outage: on 2026-10-14 a run saw 15 049
 * timeouts instead of 202 and would have marked half the registry down. When
 * far fewer servers answer than last time, the run is not trusted: no import,
 * no artifact; the next run tries again. --force skips the check.
 */
if (previousForCarry.length && !args.force) {
  const prevOk = previousForCarry.filter((r) => r.transport !== 'stdio' && r.status === 'ok').length;
  const nowOk = run.rows.filter((r) => r.result.status === 'ok').length;
  const timeouts = run.rows.filter((r) => r.result.status === 'timeout').length;
  if (nowOk < 0.7 * prevOk || timeouts > 0.2 * run.rows.length) {
    console.error(`::error::This run looks broken: ${nowOk} alive against ${prevOk} last time, ${timeouts} timeouts of ${run.rows.length}. Not importing.`);
    process.exit(2);
  }
}

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

/**
 * What changed since the previous run: servers that appeared or left the
 * registry, that went down or came back, and whose tool definitions grew or
 * shrank by a fifth and at least 500 tokens. The exact Claude count is used
 * when both runs have it, the estimate otherwise.
 */
export interface Changes {
  since: string;
  added: Array<{ name: string; status: string; tokens?: number }>;
  removed: string[];
  wentDown: Array<{ name: string; from: string; to: string }>;
  cameBack: Array<{ name: string; from: string; to: string }>;
  tokenChanges: Array<{ name: string; before: number; after: number; exact: boolean }>;
  counts: { added: number; removed: number; wentDown: number; cameBack: number; tokenChanges: number };
}
const LIVE = new Set(['ok', ...GATED_STATUSES]);
function diffRuns(previousRows: ServerRow[], current: ServerRow[]): Changes {
  const prev = new Map(previousRows.map((r) => [r.name, r]));
  const now = new Map(current.map((r) => [r.name, r]));
  const since = previousRows.reduce((a, r) => (r.probedAt > a ? r.probedAt : a), '');
  const added = current.filter((r) => !prev.has(r.name)).map((r) => ({ name: r.name, status: r.status, tokens: r.claudeTokens ?? r.toolsTokens }));
  const removed = previousRows.filter((r) => !now.has(r.name)).map((r) => r.name);
  const wentDown: Changes['wentDown'] = [];
  const cameBack: Changes['cameBack'] = [];
  const tokenChanges: Changes['tokenChanges'] = [];
  for (const r of current) {
    const p = prev.get(r.name);
    if (!p) continue;
    if (LIVE.has(p.status) && !LIVE.has(r.status)) wentDown.push({ name: r.name, from: p.status, to: r.status });
    if (!LIVE.has(p.status) && LIVE.has(r.status)) cameBack.push({ name: r.name, from: p.status, to: r.status });
    const exact = p.claudeTokens != null && r.claudeTokens != null;
    const before = exact ? p.claudeTokens! : p.toolsTokens;
    const after = exact ? r.claudeTokens! : r.toolsTokens;
    if (before != null && after != null && p.status === 'ok' && r.status === 'ok') {
      const delta = Math.abs(after - before);
      if (delta >= 500 && delta >= 0.2 * Math.max(before, 1)) tokenChanges.push({ name: r.name, before, after, exact });
    }
  }
  tokenChanges.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  added.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
  const cap = <T>(xs: T[]) => xs.slice(0, 60);
  return {
    since,
    added: cap(added), removed: cap(removed), wentDown: cap(wentDown), cameBack: cap(cameBack), tokenChanges: cap(tokenChanges),
    counts: { added: added.length, removed: removed.length, wentDown: wentDown.length, cameBack: cameBack.length, tokenChanges: tokenChanges.length }
  };
}

const previousRows = args.previous && existsSync(args.previous) ? (JSON.parse(await readFile(args.previous, 'utf8')) as ServerRow[]) : null;
const changes = previousRows ? diffRuns(previousRows, rows) : undefined;

const ok = rows.filter((r) => r.status === 'ok');
const tokens = ok.map((r) => r.toolsTokens ?? 0);
const counted = ok.filter((r) => r.claudeTokens != null);
const claude = counted.map((r) => r.claudeTokens!);
const claudeCc = counted.map((r) => r.claudeTokensCc ?? r.claudeTokens!);
const claudeModel = counted[0]?.claudeModel;
const geminiCounted = ok.filter((r) => r.geminiTokens != null);
const geminiAll = geminiCounted.map((r) => r.geminiTokens!);
/** Histogram of the exact counts: how many alive servers fall into each cost band. */
const HISTOGRAM_EDGES = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const histogram = (xs: number[]) => {
  const bins = new Array(HISTOGRAM_EDGES.length + 1).fill(0) as number[];
  for (const x of xs) bins[HISTOGRAM_EDGES.findIndex((e) => x < e) === -1 ? HISTOGRAM_EDGES.length : HISTOGRAM_EDGES.findIndex((e) => x < e)]++;
  return { edges: HISTOGRAM_EDGES, bins };
};
const uniqueToolsets = new Set(ok.map((r) => r.toolsetHash)).size;
/** Ranks by the exact Claude count when the run has one, else by the estimate. */
const weight = (r: ServerRow) => r.claudeTokens ?? (counted.length ? -1 : (r.toolsTokens ?? 0));
const summary = {
  probedAt: run.probedAt,
  registryEntries: registryRaw.filter((r) => r._meta['io.modelcontextprotocol.registry/official']?.status !== 'tracked').length,
  tracked: registryRaw.filter((r) => r._meta['io.modelcontextprotocol.registry/official']?.status === 'tracked').length,
  registryWithRemote: registryRaw.filter((r) => r.server.remotes?.length).length,
  registryWithPackage: registryRaw.filter((r) => !r.server.remotes?.length && r.server.packages?.some((p) => p.registryType === 'npm' || p.registryType === 'pypi')).length,
  stdioProbed: rows.filter((r) => r.transport === 'stdio').length,
  stdioToday: stdioRows.length,
  probed: rows.length,
  byStatus: count(rows, (r) => r.status),
  reachable: ok.length + rows.filter((r) => GATED_STATUSES.has(r.status)).length,
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
        histogram: histogram(claude),
        median: quantile(claude, 0.5), p90: quantile(claude, 0.9), p99: quantile(claude, 0.99), max: Math.max(0, ...claude), total: claude.reduce((a, b) => a + b, 0),
        claudeCode: { median: quantile(claudeCc, 0.5), p90: quantile(claudeCc, 0.9), p99: quantile(claudeCc, 0.99), max: Math.max(0, ...claudeCc), total: claudeCc.reduce((a, b) => a + b, 0) },
        /** Exact count divided by the estimate, over the counted servers. */
        ratioToEstimate: { median: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.5), p10: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.1), p90: quantile(counted.map((r) => r.claudeTokens! / Math.max(1, r.toolsTokens ?? 1)), 0.9) }
      }
    : undefined,
  geminiTokens: geminiCounted.length
    ? {
        model: geminiCounted[0]?.geminiModel,
        counted: geminiCounted.length,
        refused: ok.filter((r) => r.geminiError).length,
        median: quantile(geminiAll, 0.5), p90: quantile(geminiAll, 0.9), p99: quantile(geminiAll, 0.99), max: Math.max(0, ...geminiAll), total: geminiAll.reduce((a, b) => a + b, 0)
      }
    : undefined,
  toolCount: { median: quantile(ok.map((r) => r.toolCount ?? 0), 0.5), p90: quantile(ok.map((r) => r.toolCount ?? 0), 0.9), max: Math.max(0, ...ok.map((r) => r.toolCount ?? 0)) },
  initMs: { median: quantile(ok.map((r) => r.initMs ?? 0), 0.5), p90: quantile(ok.map((r) => r.initMs ?? 0), 0.9) },
  hosts: new Set(rows.map((r) => r.host)).size,
  changes,
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
