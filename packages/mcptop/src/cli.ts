#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverConfigs, readConfigFile, type ConfiguredServer } from './configs.js';
import { probeRemote, VERSION } from './probe.js';
import { probeStdio } from './stdio.js';
import { TOKENIZER } from './tokens.js';
import type { ProbeResult } from './types.js';

const HELP = `mcptop ${VERSION}: how many tokens do your MCP servers cost before the first prompt?

Usage
  mcptop [options]                 measure every server in the configs it can find
  mcptop --config <file>           measure one config file (repeatable)
  mcptop --url <url>               measure one remote server (repeatable)
  mcptop --stdio "<command args>"  measure one local server (repeatable)

Options
  --window <tokens>    context window for the percentages (default 200000)
  --budget <tokens>    exit with code 1 when the total is above this
  --tools <n>          list the n most expensive tools of each server (default 0)
  --claude             exact counts from the Anthropic count_tokens endpoint (free, needs ANTHROPIC_API_KEY)
  --model <id>         model for --claude (default claude-opus-5-5)
  --timeout <ms>       per server (default 15000)
  --no-stdio           do not start local servers, only measure remote ones
  --json               machine-readable output
  --help, --version

Config files it looks for: .mcp.json, ~/.claude.json, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI.
Without --claude, tokens are an estimate: ${TOKENIZER} over name, description and input schema of each tool.
With --claude, the exact count for the model is shown too, as published and with the Claude Code mcp__<server>__ prefix.
The same probe runs the public board at https://mcp-pulse.ulehla.dev`;

interface Row {
  name: string;
  source: string;
  kind: 'remote' | 'stdio';
  target: string;
  result?: ProbeResult;
  skipped?: string;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', multiple: true },
      url: { type: 'string', multiple: true },
      stdio: { type: 'string', multiple: true },
      window: { type: 'string', default: '200000' },
      budget: { type: 'string' },
      tools: { type: 'string', default: '0' },
      timeout: { type: 'string', default: '15000' },
      'no-stdio': { type: 'boolean', default: false },
      claude: { type: 'boolean', default: false },
      model: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false }
    },
    allowPositionals: true
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const window = Number(values.window) || 200_000;
  const timeoutMs = Number(values.timeout) || 15_000;
  const topTools = Number(values.tools) || 0;
  const budget = values.budget ? Number(values.budget) : undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (values.claude && !apiKey) {
    console.error('--claude needs ANTHROPIC_API_KEY in the environment. Only the free count_tokens endpoint is called.');
    return 2;
  }
  const claudeFor = (serverName: string) => (values.claude && apiKey ? { apiKey, model: values.model, serverName } : undefined);

  const servers: ConfiguredServer[] = [];
  const sources: string[] = [];
  if (values.config?.length) {
    for (const file of values.config) {
      const cfg = await readConfigFile(file, 'config');
      if (!cfg) {
        console.error(`cannot read ${file}`);
        return 2;
      }
      servers.push(...cfg.servers);
      sources.push(file);
    }
  }
  for (const url of values.url ?? []) {
    servers.push({ name: url, source: 'command line', kind: 'remote', url, type: /\/sse\/?$/.test(url) ? 'sse' : 'streamable-http' });
  }
  for (const line of values.stdio ?? []) {
    const [command, ...args] = line.trim().split(/\s+/);
    servers.push({ name: line, source: 'command line', kind: 'stdio', command, args });
  }
  if (!values.config?.length && !values.url?.length && !values.stdio?.length) {
    const found = await discoverConfigs();
    for (const cfg of found) {
      servers.push(...cfg.servers);
      sources.push(`${cfg.path} (${cfg.client}, ${cfg.servers.length})`);
    }
    if (!found.length) {
      console.error('No MCP config found. Pass --config, --url or --stdio. See --help.');
      return 2;
    }
  }

  const rows: Row[] = [];
  const running: Promise<void>[] = [];
  for (const s of servers) {
    const row: Row = { name: s.name, source: s.source, kind: s.kind, target: s.kind === 'remote' ? s.url! : [s.command, ...(s.args ?? [])].join(' ') };
    rows.push(row);
    if (s.disabled) {
      row.skipped = 'disabled in config';
      continue;
    }
    if (s.kind === 'stdio' && values['no-stdio']) {
      row.skipped = 'local server, --no-stdio';
      continue;
    }
    const job =
      s.kind === 'remote'
        ? probeRemote({ url: s.url!, type: s.type ?? 'streamable-http' }, { timeoutMs, headers: s.headers, claude: claudeFor(s.name) })
        : probeStdio({ command: s.command!, args: s.args, env: s.env, cwd: s.cwd }, { timeoutMs, claude: claudeFor(s.name) });
    running.push(job.then((r) => void (row.result = r)));
  }
  await Promise.all(running);

  const measured = rows.filter((r) => r.result?.status === 'ok');
  const exact = values.claude;
  /** The number a row is ranked and budgeted by: the exact Claude count with --claude, else the estimate. */
  const cost = (r: Row) => (exact ? r.result?.claude?.tokens : r.result?.toolsTokens);
  const total = measured.reduce((a, r) => a + (cost(r) ?? 0), 0);
  const totalEstimate = measured.reduce((a, r) => a + (r.result?.toolsTokens ?? 0), 0);
  const totalTools = measured.reduce((a, r) => a + (r.result?.toolCount ?? 0), 0);
  const model = measured.find((r) => r.result?.claude?.model)?.result?.claude?.model ?? values.model ?? 'claude-opus-5-5';
  rows.sort((a, b) => (cost(b) ?? -1) - (cost(a) ?? -1));

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          tokenizer: TOKENIZER,
          exact: exact ? { endpoint: 'count_tokens', model } : null,
          window,
          sources,
          total: { servers: measured.length, tools: totalTools, tokens: total, tokensEstimate: totalEstimate, shareOfWindow: total / window },
          servers: rows.map((r) => ({
            name: r.name,
            source: r.source,
            kind: r.kind,
            target: r.target,
            skipped: r.skipped,
            status: r.result?.status,
            error: r.result?.error,
            toolCount: r.result?.toolCount,
            toolsTokens: r.result?.toolsTokens,
            claudeTokens: r.result?.claude?.tokens,
            claudeTokensClaudeCode: r.result?.claude?.tokensClaudeCode,
            claudeError: r.result?.claude?.error,
            shareOfWindow: cost(r) != null ? cost(r)! / window : undefined,
            initializeMs: r.result?.latencyMs.initialize,
            toolsListMs: r.result?.latencyMs.toolsList,
            protocolVersion: r.result?.protocolVersion,
            tools: topTools > 0 ? r.result?.tools?.slice().sort((a, b) => b.tokens - a.tokens).slice(0, topTools) : undefined
          }))
        },
        null,
        2
      )
    );
  } else {
    console.log(render(rows, { window, total, totalTools, topTools, sources, exact, model, cost }));
  }

  if (budget !== undefined && total > budget) {
    console.error(`\nOver budget: ${fmt(total)} tokens, the budget is ${fmt(budget)}.`);
    return 1;
  }
  return 0;
}

function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null) return '';
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

function pct(n: number, window: number): string {
  const p = (n / window) * 100;
  return p < 0.1 && n > 0 ? '<0.1 %' : `${p.toFixed(1)} %`;
}

function shortSource(source: string): string {
  return source.replace(homedir(), '~').replace(/ \(project .*\)$/, ' (project)');
}

function statusText(r: Row): string {
  if (r.skipped) return `skipped: ${r.skipped}`;
  const s = r.result?.status;
  if (!s) return '';
  if (s === 'ok') return 'alive';
  if (s === 'auth') return `needs auth${r.result?.authScheme ? ` (${r.result.authScheme})` : ''}`;
  if (s === 'payment') return 'payment required';
  if (s === 'newer_protocol') return 'newer protocol than this SDK';
  if (s === 'not_found') return r.kind === 'stdio' ? 'command not found' : 'not found';
  return s.replace('_', ' ');
}

function render(rows: Row[], o: { window: number; total: number; totalTools: number; topTools: number; sources: string[]; exact: boolean; model: string; cost: (r: Row) => number | undefined }): string {
  const lines: string[] = [];
  lines.push(`mcptop ${VERSION} · tool definitions your agent loads before the first prompt`);
  if (o.sources.length) lines.push(o.sources.map((s) => `  ${shortSource(s)}`).join('\n'));
  lines.push('');
  if (!rows.length) {
    lines.push('  No servers in these configs.');
    return lines.join('\n');
  }
  const table: string[][] = [
    o.exact
      ? ['server', 'source', 'result', 'tools', 'claude', 'claude code', 'o200k', `of ${Math.round(o.window / 1000)}k`]
      : ['server', 'source', 'result', 'tools', 'tokens', `of ${Math.round(o.window / 1000)}k`]
  ];
  for (const r of rows) {
    const ok = r.result?.status === 'ok';
    const c = r.result?.claude;
    table.push([
      r.name.length > 28 ? r.name.slice(0, 27) + '…' : r.name,
      shortSource(r.source).replace(/^.*\//, ''),
      statusText(r),
      ok ? fmt(r.result?.toolCount) : '',
      ...(o.exact ? [ok ? (c?.tokens != null ? fmt(c.tokens) : c?.error ? 'refused' : '') : '', ok ? fmt(c?.tokensClaudeCode) : ''] : []),
      ok ? fmt(r.result?.toolsTokens) : '',
      ok && o.cost(r) != null ? pct(o.cost(r)!, o.window) : ''
    ]);
  }
  const totalEstimate = rows.reduce((a, r) => a + (r.result?.status === 'ok' ? (r.result.toolsTokens ?? 0) : 0), 0);
  const totalCc = rows.reduce((a, r) => a + (r.result?.claude?.tokensClaudeCode ?? 0), 0);
  table.push([
    'total', '', `${rows.filter((r) => r.result?.status === 'ok').length} of ${rows.length} measured`, fmt(o.totalTools),
    ...(o.exact ? [fmt(o.total), fmt(totalCc)] : []),
    fmt(totalEstimate), pct(o.total, o.window)
  ]);
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  const right = new Set(table[0].map((_, i) => i).filter((i) => i >= 3));
  const line = (row: string[]) => '  ' + row.map((cell, i) => (right.has(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ').trimEnd();
  lines.push(line(table[0]));
  lines.push('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of table.slice(1, -1)) lines.push(line(row));
  lines.push('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  lines.push(line(table[table.length - 1]));

  const failed = rows.filter((r) => r.result && r.result.status !== 'ok' && r.result.error);
  if (failed.length) {
    lines.push('');
    for (const r of failed) lines.push(`  ${r.name}: ${r.result!.error!.split('\n')[0].slice(0, 160)}`);
  }
  if (o.topTools > 0) {
    for (const r of rows) {
      if (!r.result?.tools?.length) continue;
      lines.push('', `  ${r.name}: most expensive tools`);
      for (const t of [...r.result.tools].sort((a, b) => b.tokens - a.tokens).slice(0, o.topTools)) {
        lines.push(`    ${fmt(t.tokens).padStart(7)}  ${t.name}`);
      }
    }
  }
  if (o.exact) {
    lines.push('', `  claude: exact count from the Anthropic count_tokens endpoint for ${o.model}. claude code: the same with the mcp__<server>__ prefix on each tool name.`);
    lines.push(`  o200k: the estimate without a key, ${TOKENIZER} over name, description and input schema. "refused": the endpoint did not accept the schema.`);
    const refused = rows.filter((r) => r.result?.claude?.error);
    for (const r of refused) lines.push(`  ${r.name}: ${r.result!.claude!.error!.slice(0, 160)}`);
  } else {
    lines.push('', `  Estimated with ${TOKENIZER} over name, description and input schema of each tool. Claude counts about 1.9 times this. Add --claude for the exact count.`);
  }
  return lines.join('\n');
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    // The bin is a symlink in node_modules/.bin, so compare real paths.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  );
}
