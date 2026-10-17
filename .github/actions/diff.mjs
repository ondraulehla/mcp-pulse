// The difference between two mcpcost --json runs, and the pull request comment that reports it.
// Pure functions, no I/O: comment.mjs does the reading and the posting.

export const MARKER = '<!-- mcpcost-action -->';

/** The number a server is compared by: the exact Claude count when the run had one, else the estimate. */
function costOf(run, server) {
  return server.tokens ?? (run?.exact ? server.claudeTokens : server.toolsTokens);
}

function resultOf(server) {
  if (!server) return '';
  if (server.skipped) return `skipped: ${server.skipped}`;
  return server.status === 'ok' ? 'alive' : String(server.status ?? '').replace(/_/g, ' ');
}

/**
 * Compares the servers of the base run with those of the head run, by config name.
 * @returns {{ added: object[], removed: object[], changed: Array<{ before: object, after: object }>, unchanged: object[], totals: { before: number, after: number, delta: number } }}
 */
export function diffRuns(base, head) {
  const baseByName = new Map((base?.servers ?? []).map((s) => [s.name, s]));
  const headByName = new Map((head?.servers ?? []).map((s) => [s.name, s]));
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const after of head?.servers ?? []) {
    const before = baseByName.get(after.name);
    if (!before) {
      added.push(after);
      continue;
    }
    const same =
      (costOf(base, before) ?? null) === (costOf(head, after) ?? null) &&
      (before.toolCount ?? null) === (after.toolCount ?? null) &&
      resultOf(before) === resultOf(after);
    (same ? unchanged : changed).push(same ? after : { before, after });
  }
  const removed = (base?.servers ?? []).filter((s) => !headByName.has(s.name));
  const before = base?.total?.tokens ?? 0;
  const after = head?.total?.tokens ?? 0;
  return { added, removed, changed, unchanged, totals: { before, after, delta: after - before } };
}

const fmt = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');

/**
 * The Markdown of the sticky comment.
 * @param {object} o
 * @param {object} o.head the head run (mcpcost --json)
 * @param {object|null} o.base the base run, or null when there was none
 * @param {ReturnType<typeof diffRuns>} o.diff
 * @param {number|undefined} o.budget
 * @param {string} [o.baseRef] the base branch name, for the text
 */
export function renderComment({ head, base, diff, budget, baseRef }) {
  const window = head.window ?? 200_000;
  const pct = (n) => (n == null ? '' : `${((n / window) * 100).toFixed(1)} %`);
  const unit = head.exact ? ` (${head.exact.model})` : ' (o200k estimate)';
  const total = diff.totals.after;
  const over = budget != null && total > budget;
  const lines = [MARKER];
  const deltaText = base ? ` (${signed(diff.totals.delta)} against ${baseRef ? `\`${baseRef}\`` : 'the base branch'})` : '';
  lines.push(`## mcpcost: ${fmt(total)} tokens of context before the first prompt${deltaText}`, '');
  if (over) lines.push(`**Over budget.** The budget is ${fmt(budget)} tokens.`, '');
  else if (budget != null) lines.push(`Within the budget of ${fmt(budget)} tokens.`, '');

  const rows = [];
  for (const s of diff.added) rows.push(`| ${s.name} | added | ${resultOf(s)} | ${fmt(s.toolCount)} | ${fmt(costOf(head, s))} | ${signed(costOf(head, s) ?? 0)} |`);
  for (const s of diff.removed) rows.push(`| ${s.name} | removed | ${resultOf(s)} | ${fmt(s.toolCount)} | | ${signed(-(costOf(base, s) ?? 0))} |`);
  for (const { before, after } of diff.changed) {
    const b = costOf(base, before) ?? 0;
    const a = costOf(head, after) ?? 0;
    const what = resultOf(before) !== resultOf(after) ? `${resultOf(before)} → ${resultOf(after)}` : 'changed';
    rows.push(`| ${after.name} | ${what} | ${resultOf(after)} | ${fmt(after.toolCount)} | ${fmt(costOf(head, after))} | ${signed(a - b)} |`);
  }
  if (rows.length) {
    lines.push(`| Server | Change | Result | Tools | Tokens${unit} | Δ |`, '|---|---|---|---:|---:|---:|', ...rows, '');
  } else if (base) {
    lines.push('No server changed.', '');
  }
  const measured = head.total?.servers ?? 0;
  const all = head.servers?.length ?? 0;
  lines.push(`${measured} of ${all} servers measured, ${fmt(head.total?.tools)} tools, ${fmt(total)} tokens, ${pct(total)} of a ${Math.round(window / 1000)}k window.${diff.unchanged.length && rows.length ? ` ${diff.unchanged.length} unchanged.` : ''}`, '');

  const changedNames = new Set([...diff.added, ...diff.changed.map((c) => c.after)].map((s) => s.name));
  const top = (head.servers ?? []).filter((s) => changedNames.has(s.name) && s.tools?.length);
  if (top.length) {
    lines.push('<details><summary>Most expensive tools of the servers that changed</summary>', '');
    for (const s of top) {
      lines.push(`**${s.name}**`, '');
      for (const t of s.tools) lines.push(`- ${fmt(t.tokens)} \`${t.name}\``);
      lines.push('');
    }
    lines.push('</details>', '');
  }
  if (!base) lines.push('No measurement of the base branch, so every server counts as added.', '');
  lines.push(
    head.exact
      ? 'Exact counts from the Anthropic count_tokens endpoint. Other models tokenize differently.'
      : 'Estimate with the o200k_base tokenizer. Claude counts about 1.8 times more; set `claude: true` with `ANTHROPIC_API_KEY` for exact numbers.',
    '',
    'Measured by [mcpcost](https://github.com/ondraulehla/mcpcost). The job summary has the full table.'
  );
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
