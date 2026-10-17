// Turns mcpcost --json into a job summary table. Works with any mcpcost version: fields it does not find stay empty.
import { readFileSync } from 'node:fs';
const [file, budget] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, 'utf8'));
const fmt = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const pct = (n) => (n == null ? '' : `${((n / r.window) * 100).toFixed(1)} %`);
const exact = Boolean(r.exact);
const rows = r.servers.map((s) => {
  const cost = s.tokens ?? (exact ? s.claudeTokens : s.toolsTokens);
  const result = s.skipped ? `skipped: ${s.skipped}` : s.status === 'ok' ? 'alive' : (s.status ?? '').replace('_', ' ');
  return `| ${s.name} | ${result} | ${fmt(s.toolCount)} | ${fmt(cost)} | ${pct(cost)} |`;
});
const total = r.total.tokens;
const over = budget && total > Number(budget);
const lines = [
  `## mcpcost: ${fmt(total)} tokens of context before the first prompt`,
  '',
  over ? `**Over budget.** The budget is ${fmt(Number(budget))} tokens.` : budget ? `Within the budget of ${fmt(Number(budget))} tokens.` : '',
  '',
  `| Server | Result | Tools | Tokens${exact ? ` (${r.exact.model})` : ' (o200k estimate)'} | Of ${Math.round(r.window / 1000)}k |`,
  '|---|---|---:|---:|---:|',
  ...rows,
  `| **total** | ${r.total.servers} of ${r.servers.length} measured | ${fmt(r.total.tools)} | **${fmt(total)}** | ${pct(total)} |`,
  ''
];
const top = r.servers.filter((s) => s.tools?.length);
if (top.length) {
  lines.push('<details><summary>Most expensive tools</summary>', '');
  for (const s of top) {
    lines.push(`**${s.name}**`, '');
    for (const t of s.tools) lines.push(`- ${fmt(t.tokens)} \`${t.name}\``);
    lines.push('');
  }
  lines.push('</details>', '');
}
lines.push(
  exact
    ? 'Exact counts from the Anthropic count_tokens endpoint. Other models tokenize differently.'
    : 'Estimate with the o200k_base tokenizer over name, description and input schema of each tool. Claude counts about 1.8 times more; set `claude: true` with `ANTHROPIC_API_KEY` for exact numbers.',
  '',
  'Measured by [mcpcost](https://github.com/ondraulehla/mcpcost). The board at [mcpcost.ulehla.dev](https://mcpcost.ulehla.dev) has the same numbers for every server in the MCP registry.'
);
console.log(lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
