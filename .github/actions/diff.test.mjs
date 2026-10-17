import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, renderComment, MARKER } from './diff.mjs';

const run = (servers, exact = false) => ({
  window: 200_000,
  exact: exact ? { endpoint: 'count_tokens', model: 'claude-opus-5-5' } : null,
  total: { servers: servers.filter((s) => s.status === 'ok').length, tools: 0, tokens: servers.reduce((a, s) => a + (s.status === 'ok' ? (exact ? s.claudeTokens : s.toolsTokens) ?? 0 : 0), 0) },
  servers
});
const ok = (name, toolsTokens, toolCount = 3, extra = {}) => ({ name, status: 'ok', toolCount, toolsTokens, ...extra });

test('added, removed, changed and unchanged servers', () => {
  const base = run([ok('a', 1000), ok('b', 2000), ok('gone', 500)]);
  const head = run([ok('a', 1000), ok('b', 2600), ok('new', 12_400)]);
  const d = diffRuns(base, head);
  assert.deepEqual(d.added.map((s) => s.name), ['new']);
  assert.deepEqual(d.removed.map((s) => s.name), ['gone']);
  assert.deepEqual(d.changed.map((c) => c.after.name), ['b']);
  assert.deepEqual(d.unchanged.map((s) => s.name), ['a']);
  assert.equal(d.totals.before, 3500);
  assert.equal(d.totals.after, 16_000);
  assert.equal(d.totals.delta, 12_500);
});

test('a status change counts as a change even when the cost is the same', () => {
  const base = run([ok('a', 1000)]);
  const head = run([{ name: 'a', status: 'auth', toolCount: undefined, toolsTokens: undefined }]);
  const d = diffRuns(base, head);
  assert.equal(d.changed.length, 1);
  assert.equal(d.unchanged.length, 0);
});

test('exact runs compare the Claude count, not the estimate', () => {
  const base = run([ok('a', 1000, 3, { claudeTokens: 1900 })], true);
  const head = run([ok('a', 1000, 3, { claudeTokens: 2100 })], true);
  const d = diffRuns(base, head);
  assert.equal(d.changed.length, 1);
  assert.equal(d.totals.delta, 200);
});

test('no base run: every server is added', () => {
  const head = run([ok('a', 1000), ok('b', 2000)]);
  const d = diffRuns(null, head);
  assert.equal(d.added.length, 2);
  assert.equal(d.removed.length, 0);
  assert.equal(d.totals.before, 0);
});

test('the comment carries the marker, the delta, the rows and the budget verdict', () => {
  const base = run([ok('a', 1000)]);
  const head = run([ok('a', 1000), ok('new', 12_400, 20, { tools: [{ name: 'big_tool', tokens: 4000 }] })]);
  const md = renderComment({ head, base, diff: diffRuns(base, head), budget: 10_000, baseRef: 'main' });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /13,400 tokens of context before the first prompt \(\+12,400 against `main`\)/);
  assert.match(md, /\*\*Over budget\.\*\* The budget is 10,000 tokens\./);
  assert.match(md, /\| new \| added \| alive \| 20 \| 12,400 \| \+12,400 \|/);
  assert.match(md, /1 unchanged\./);
  assert.match(md, /- 4,000 `big_tool`/);
  assert.doesNotMatch(md, /\n\n\n/);
});

test('no change at all says so', () => {
  const base = run([ok('a', 1000)]);
  const md = renderComment({ head: base, base, diff: diffRuns(base, base), budget: undefined, baseRef: 'main' });
  assert.match(md, /\(±0 against `main`\)/);
  assert.match(md, /No server changed\./);
  assert.doesNotMatch(md, /budget/);
});
