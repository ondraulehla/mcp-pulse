/**
 * Probes a sample of remote servers from the MCP registry and writes the results
 * to data/. Usage:
 *   npm run probe -- --sample 200 --per-host 2 --concurrency 16
 *   npm run probe -- --all --out data/raw/probe-all.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchRegistry, hostOf, primaryRemote, probeRemote } from '../packages/mcptop/src/index.js';
import type { ProbeResult, RegistryEntry } from '../packages/mcptop/src/index.js';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '200' },
    'per-host': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '16' },
    timeout: { type: 'string', default: '15000' },
    all: { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    cache: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string' }
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
async function runAll(targets: Target[]): Promise<Array<Target & { result: ProbeResult }>> {
  const out: Array<Target & { result: ProbeResult }> = [];
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
        const result = await probeRemote({ url: target.url, type: target.type }, { timeoutMs });
        out.push({ ...target, result });
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
const stamp = new Date().toISOString().slice(0, 10);
await mkdir('data/samples', { recursive: true });
const file = args.out ?? `data/samples/probe-${stamp}${args.all ? '-all' : `-n${targets.length}`}.json`;
await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
await writeFile(file, JSON.stringify({ probedAt: new Date().toISOString(), options: { ...args }, summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.error(`written ${file}`);
