/**
 * Exact token counts from the Anthropic count_tokens endpoint. The endpoint is
 * free and has its own rate limit. Nothing here calls a model.
 *
 * Method: count a request that holds one tiny marker tool plus the server's
 * tools, and subtract the count of the same request with only the marker tool.
 * Both requests carry the tool-use system prompt, so it cancels out. What is
 * left is exactly what the server's tool definitions add, as this model
 * renders and tokenizes them. No constants from the docs are needed.
 *
 * This file has no Node dependencies, so the Worker can import it too.
 */
import type { ToolLike } from './payload.js';

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

export interface ClaudeCountOptions {
  apiKey: string;
  /** Model id. Default claude-opus-5-5. */
  model?: string;
  /** Prefix for every tool name, for example `mcp__github__` as Claude Code sends them. */
  prefix?: string;
  fetch?: typeof fetch;
  /** Retries on 429 and 5xx. Default 5. */
  retries?: number;
  /** Timeout for one request. Default 30 s. */
  timeoutMs?: number;
  /** Shared rate limiter from createLimiter, for many servers in one process. */
  limiter?: Limiter;
}

export interface Limiter {
  /** Resolves when the next request may start. */
  wait(): Promise<void>;
}

/**
 * Lets at most `rpm` requests start in any sliding minute. Organisations have a
 * count_tokens limit of their own (100 a minute on a small one), and a 429
 * costs more time than waiting for a slot.
 */
export function createLimiter(rpm: number): Limiter {
  const starts: number[] = [];
  let chain = Promise.resolve();
  return {
    wait() {
      chain = chain.then(async () => {
        for (;;) {
          const now = Date.now();
          while (starts.length && now - starts[0] >= 60_000) starts.shift();
          if (starts.length < rpm) break;
          await new Promise((r) => setTimeout(r, starts[0] + 60_000 - now + 20));
        }
        starts.push(Date.now());
      });
      return chain;
    }
  };
}

export interface ClaudeCount {
  model: string;
  /** Tokens the tool definitions add to a request. */
  tokens: number;
}

/** The answer when Claude refuses to count, for example on a schema it does not accept. */
export class ClaudeCountError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ClaudeCountError';
  }
}

const MARKER = { name: 'mcp_pulse_marker', description: '', input_schema: { type: 'object', properties: {} } };
const MESSAGES = [{ role: 'user', content: 'hi' }];

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'tool';

/** The tool list as the Messages API takes it. Names are made safe and unique, because the API refuses duplicates. */
export function toApiTools(tools: ToolLike[], prefix = ''): Array<{ name: string; description: string; input_schema: unknown }> {
  const seen = new Map<string, number>();
  return tools.map((t) => {
    let name = safeName(prefix + t.name);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name.slice(0, 124)}_${n + 1}`;
    return {
      name,
      description: t.description ?? '',
      input_schema: (t.inputSchema as object | undefined) ?? { type: 'object', properties: {} }
    };
  });
}

async function countRequest(body: object, options: ClaudeCountOptions): Promise<number> {
  const doFetch = options.fetch ?? fetch;
  const retries = options.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    if (options.limiter) await options.limiter.wait();
    let res: Response;
    try {
      res = await doFetch(COUNT_TOKENS_URL, {
        method: 'POST',
        headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new ClaudeCountError(e instanceof Error ? e.message : String(e), 0);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as { input_tokens?: number; error?: { message?: string } };
    if (!res.ok) throw new ClaudeCountError((json.error?.message ?? `HTTP ${res.status}`).slice(0, 300), res.status);
    return json.input_tokens ?? 0;
  }
}

const baselines = new Map<string, Promise<number>>();

/** Tokens of the message plus the marker tool, once per model and process. */
function baseline(model: string, options: ClaudeCountOptions): Promise<number> {
  let p = baselines.get(model);
  if (!p) {
    p = countRequest({ model, messages: MESSAGES, tools: [MARKER] }, options);
    p.catch(() => baselines.delete(model));
    baselines.set(model, p);
  }
  return p;
}

/** Exact tokens these tool definitions add to a request for this model. */
export async function countClaudeTokens(tools: ToolLike[], options: ClaudeCountOptions): Promise<ClaudeCount> {
  const model = options.model ?? CLAUDE_MODEL;
  if (!tools.length) return { model, tokens: 0 };
  const base = await baseline(model, options);
  const withTools = await countRequest({ model, messages: MESSAGES, tools: [MARKER, ...toApiTools(tools, options.prefix)] }, options);
  return { model, tokens: Math.max(0, withTools - base) };
}

/** Claude Code names a tool mcp__<server>__<tool>. The server part is the key in the config. */
export function claudeCodePrefix(serverName: string): string {
  const slug = (serverName.split('/').pop() ?? serverName).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${slug}__`;
}

/** Exact counts for a server: as published, and as Claude Code sends them. */
export async function countForServer(
  tools: ToolLike[],
  serverName: string,
  options: ClaudeCountOptions
): Promise<{ model: string; tokens: number; tokensClaudeCode: number }> {
  const [plain, cc] = await Promise.all([countClaudeTokens(tools, options), countClaudeTokens(tools, { ...options, prefix: claudeCodePrefix(serverName) })]);
  return { model: plain.model, tokens: plain.tokens, tokensClaudeCode: cc.tokens };
}
