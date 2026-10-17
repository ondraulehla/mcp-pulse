/**
 * Adds exact Claude counts to a stdio run file. The stdio workflow has no
 * secrets, so counting happens here, in the daily probe that has the key.
 *   node --import tsx probe/count-tools.ts --in data/raw/stdio-run.json --cache data/cache/servers.json --out data/raw/stdio-run.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClaudeCounter, payloadHash } from './claude-cache.js';
import { createGeminiCounter } from './gemini-cache.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';
import type { ProbeResult } from '../packages/mcpcost/src/index.js';

const { values: args } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' }, cache: { type: 'string' }, 'deadline-min': { type: 'string', default: '60' } } });
if (!args.in) throw new Error('--in is required');
const file = JSON.parse(await readFile(args.in, 'utf8')) as { rows: Array<{ name: string; status: string; result?: ProbeResult; tools?: RawTool[]; payloadHash?: string }> };
const deadline = Date.now() + Number(args['deadline-min']) * 60_000;
const claude = await createClaudeCounter({ apiKey: process.env.ANTHROPIC_API_KEY, cachePath: args.cache, deadline });
const gemini = await createGeminiCounter({ apiKey: process.env.GEMINI_API_KEY, cachePath: args.cache, deadline });
for (const row of file.rows) {
  if (row.status !== 'ok' || !row.result || !row.tools?.length) continue;
  row.payloadHash = payloadHash(row.tools);
  row.result.claude = await claude.count(row.name, row.tools, row.payloadHash);
  row.result.gemini = await gemini.count(row.name, row.tools, row.payloadHash);
}
await writeFile(args.out ?? args.in, JSON.stringify(file));
const c = claude.stats();
console.error(claude.enabled ? `stdio Claude counts: ${c.counted} counted, ${c.reused} reused, ${c.skipped} skipped` : 'ANTHROPIC_API_KEY is not set: stdio rows get no exact counts.');
const g = gemini.stats();
console.error(gemini.enabled ? `stdio Gemini counts: ${g.counted} counted, ${g.reused} reused, ${g.skipped} skipped` : 'GEMINI_API_KEY is not set: stdio rows get no Gemini counts.');
