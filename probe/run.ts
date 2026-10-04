/**
 * Probes a sample of remote servers from the MCP registry and writes the results
 * to data/. Usage:
 *   npm run probe -- --sample 200 --per-host 2 --concurrency 16
 *   npm run probe -- --all --out data/raw/probe-all.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fetchRegistry, hostOf, primaryRemote, countForServer, ClaudeCountError, CLAUDE_MODEL, toolPayload } from '../packages/mcptop/src/index.js';
import { probeRemoteRaw, type RawTool } from '../packages/mcptop/src/core.js';
import { priceTools } from '../packages/mcptop/src/probe.js';
import type { ProbeResult, RegistryEntry, ClaudeTokens } from '../packages/mcptop/src/index.js';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '200' },
    'per-host': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '16' },
    timeout: { type: 'string', default: '15000' },
    all: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    cache: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string' },
    /** servers.json of the previous run. Servers whose tools did not change keep their Claude count from it. */
    'claude-cache': { type: 'string' },
    'claude-model': { type: 'string', default: CLAUDE_MODEL }
  }
});

const sampleSize = Number(args.sample);
const perHost = Number(args['per-host']);
const concurrency = Number(args.concurrency);
const timeoutMs = Number(args.timeout);

interface Target {
  name: string;
  url: string;
  type: 'streamable-http' | 'sse';
  host: string;
  updatedAt: string;
  status: string;
}

/**
 * Exact Claude counts come from the free count_tokens endpoint. The key is
 * optional: without it the run records only the o200k estimate. A count is
 * reused from the previous run when the server name and the full tool payload
 * are the same, so a daily run asks only about servers that changed.
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const claudeModel = args['claude-model'];
type CachedClaude = ClaudeTokens & { payloadHash?: string };
const claudeCache = new Map<string, CachedClaude>();
if (args['claude-cache'] && existsSync(args['claude-cache'])) {
  const prev = JSON.parse(await readFile(args['claude-cache'], 'utf8')) as Array<{ name: string; payloadHash?: string; claudeModel?: string; claudeTokens?: number; claudeTokensCc?: number; claudeMeasuredAt?: string; claudeError?: string }>;
  for (const p of prev) {
    if (p.payloadHash && p.claudeModel === claudeModel && p.claudeMeasuredAt && (p.claudeTokens != null || p.claudeError)) {
      claudeCache.set(p.name, { payloadHash: p.payloadHash, model: p.claudeModel, tokens: p.claudeTokens, tokensClaudeCode: p.claudeTokensCc, measuredAt: p.claudeMeasuredAt, error: p.claudeError });
    }
  }
  console.error(`${claudeCache.size} Claude counts loaded from ${args['claude-cache']}`);
}
let claudeRequests = 0;
let claudeReused = 0;

/** Hash of the full tool payloads. Equal hashes mean the same definitions, byte for byte. */
export function payloadHash(tools: RawTool[]): string {
  return createHash('sha1').update(tools.map(toolPayload).join('\u0000')).digest('hex').slice(0, 16);
}

async function claudeCount(name: string, tools: RawTool[], hash: string): Promise<ClaudeTokens | undefined> {
  if (!apiKey) return undefined;
  const cached = claudeCache.get(name);
  if (cached && cached.payloadHash === hash) {
    claudeReused++;
    const { payloadHash: _h, ...rest } = cached;
    return rest;
  }
  claudeRequests++;
  const measuredAt = new Date().toISOString();
  try {
    const c = await countForServer(tools, name, { apiKey, model: claudeModel });
    return { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt };
  } catch (e) {
    const message = e instanceof ClaudeCountError ? e.message : String(e);
    // A refused schema is a stable fact about the server; a transport failure is not, so leave it out and retry next run.
    if (e instanceof ClaudeCountError && e.status >= 400 && e.status < 500 && e.status !== 429) return { model: claudeModel, measuredAt, error: message };
    console.error(`  count_tokens failed for ${name}: ${message}`);
    return undefined;
  }
}

async function loadRegistry(): Promise<RegistryEntry[]> {
  if (existsSync(args.cache)) {
    const raw = JSON.parse(await readFile(args.cache, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
    return raw.map((r) => ({ server: r.server, meta: r._meta['io.modelcontextprotocol.registry/official'] }));
  }
  console.error('downloading registry…');
  const entries = await fetchRegistry({ onPage: (n) => n % 2000 === 0 && console.error(`  ${n} entries`) });
  await mkdir('data/raw', { recursive: true });
  await writeFile(args.cache, JSON.stringify(entries.map((e) => ({ server: e.server, _meta: { 'io.modelcontextprotocol.registry/official': e.meta } }))));
  return entries;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickTargets(entries: RegistryEntry[]): Target[] {
  const all: Target[] = [];
  for (const e of entries) {
    const remote = primaryRemote(e);
    if (!remote) continue;
    all.push({ name: e.server.name, url: remote.url, type: remote.type, host: hostOf(remote.url), updatedAt: e.meta.updatedAt, status: e.meta.status });
  }
  if (args.all) return all;
  const rand = mulberry32(Number(args.seed));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const perHostCount = new Map<string, number>();
  const picked: Target[] = [];
  for (const t of all) {
    const n = perHostCount.get(t.host) ?? 0;
    if (n >= perHost) continue;
    perHostCount.set(t.host, n + 1);
    picked.push(t);
    if (picked.length >= sampleSize) break;
  }
  return picked;
}

/** Runs probes with a global concurrency limit and at most one in flight per host. */
async function runAll(targets: Target[]): Promise<Array<Target & { result: ProbeResult; payloadHash?: string }>> {
  const out: Array<Target & { result: ProbeResult; payloadHash?: string }> = [];
  const busyHosts = new Set<string>();
  const queue = [...targets];
  let done = 0;
  const started = Date.now();

  async function worker() {
    while (queue.length) {
      const idx = queue.findIndex((t) => !busyHosts.has(t.host));
      if (idx === -1) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const [target] = queue.splice(idx, 1);
      busyHosts.add(target.host);
      try {
        const { result, tools } = await probeRemoteRaw({ url: target.url, type: target.type }, { timeoutMs });
        priceTools(result, tools);
        let hash: string | undefined;
        if (result.status === 'ok' && tools.length) {
          hash = payloadHash(tools);
          busyHosts.delete(target.host);
          result.claude = await claudeCount(target.name, tools, hash);
        }
        out.push({ ...target, result, payloadHash: hash });
      } finally {
        busyHosts.delete(target.host);
        done++;
        if (done % 25 === 0 || done === targets.length) {
          const s = Math.round((Date.now() - started) / 1000);
          console.error(`  ${done}/${targets.length} probed (${s}s)`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

function summarize(rows: Array<Target & { result: ProbeResult }>) {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.result.status] = (byStatus[r.result.status] ?? 0) + 1;
  const ok = rows.filter((r) => r.result.status === 'ok');
  const tokens = ok.map((r) => r.result.toolsTokens ?? 0).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);
  const init = ok.map((r) => r.result.latencyMs.initialize ?? 0).sort((a, b) => a - b);
  const top = [...ok].sort((a, b) => (b.result.toolsTokens ?? 0) - (a.result.toolsTokens ?? 0)).slice(0, 10)
    .map((r) => ({ name: r.name, tools: r.result.toolCount, tokens: r.result.toolsTokens }));
  const protocols: Record<string, number> = {};
  for (const r of ok) protocols[r.result.protocolVersion ?? 'unknown'] = (protocols[r.result.protocolVersion ?? 'unknown'] ?? 0) + 1;
  const authSchemes: Record<string, number> = {};
  for (const r of rows.filter((r) => r.result.status === 'auth')) {
    const k = r.result.authScheme ?? 'none';
    authSchemes[k] = (authSchemes[k] ?? 0) + 1;
  }
  return {
    probed: rows.length,
    byStatus,
    ok: ok.length,
    toolsTokens: { median: median(tokens), p90: tokens[Math.floor(tokens.length * 0.9)] ?? 0, max: tokens.at(-1) ?? 0 },
    initializeMs: { median: median(init), p90: init[Math.floor(init.length * 0.9)] ?? 0 },
    protocols,
    authSchemes,
    top
  };
}

const entries = await loadRegistry();
const targets = pickTargets(entries);
console.error(`${entries.length} registry entries, ${targets.length} targets, concurrency ${concurrency}, timeout ${timeoutMs}ms`);
const rows = await runAll(targets);
const summary = summarize(rows);
if (apiKey) console.error(`Claude counts: ${claudeRequests} servers counted now, ${claudeReused} reused from the previous run`);
else console.error('ANTHROPIC_API_KEY is not set: no exact Claude counts in this run.');
const stamp = new Date().toISOString().slice(0, 10);
await mkdir('data/samples', { recursive: true });
const file = args.out ?? `data/samples/probe-${stamp}${args.all ? '-all' : `-n${targets.length}`}.json`;
await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
await writeFile(file, JSON.stringify({ probedAt: new Date().toISOString(), options: { ...args }, summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.error(`written ${file}`);
