// Posts, or updates, the one mcpcost comment on a pull request.
// Usage: node comment.mjs <head.json> [<base.json>|-] [<budget>]
// Needs GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY, GITHUB_EVENT_PATH and GITHUB_BASE_REF from the runner.
import { readFileSync, existsSync } from 'node:fs';
import { diffRuns, renderComment, MARKER } from './diff.mjs';

const [headFile, baseFile, budgetArg] = process.argv.slice(2);
const head = JSON.parse(readFileSync(headFile, 'utf8'));
const base = baseFile && baseFile !== '-' && existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : null;
const budget = budgetArg ? Number(budgetArg) : undefined;

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const number = event.pull_request?.number ?? event.number;
if (!token || !repo || !number) {
  console.log('::warning title=mcpcost::No pull request number or token, so no comment was posted.');
  process.exit(0);
}

const body = renderComment({ head, base, diff: diffRuns(base, head), budget, baseRef: process.env.GITHUB_BASE_REF });
const api = `https://api.github.com/repos/${repo}`;
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'mcpcost-action'
};

async function call(method, path, payload) {
  const res = await fetch(`${api}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function findExisting() {
  for (let page = 1; page <= 10; page++) {
    const comments = await call('GET', `/issues/${number}/comments?per_page=100&page=${page}`);
    const mine = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (mine) return mine;
    if (comments.length < 100) return null;
  }
  return null;
}

try {
  const existing = await findExisting();
  if (existing) {
    await call('PATCH', `/issues/comments/${existing.id}`, { body });
    console.log(`mcpcost: updated the comment on #${number}.`);
  } else {
    await call('POST', `/issues/${number}/comments`, { body });
    console.log(`mcpcost: commented on #${number}.`);
  }
} catch (err) {
  // The measurement and the budget check stand on their own; a comment that cannot be posted is a warning.
  console.log(`::warning title=mcpcost::Could not post the pull request comment: ${err.message}. Give the job "pull-requests: write".`);
}
