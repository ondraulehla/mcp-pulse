/**
 * Exact token counts from the Gemini countTokens endpoint. The endpoint is free
 * and calls no model. Same method as claude.ts: one request with a marker
 * function plus the server's tools, one with the marker only, and the
 * difference is what the tool definitions add for this model.
 *
 * Function declarations go in as `parametersJsonSchema`, so the server's JSON
 * Schema is sent as it is, not converted to the OpenAPI subset.
 *
 * This file has no Node dependencies, so the Worker can import it too.
 */
import type { ToolLike } from './payload.js';
import type { Limiter } from './claude.js';

export const GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiCountOptions {
  apiKey: string;
  /** Model id. Default gemini-3.8-flash. */
  model?: string;
  fetch?: typeof fetch;
  /** Retries on 429 and 5xx. Default 5. */
  retries?: number;
  /** Timeout for one request. Default 30 s. */
  timeoutMs?: number;
  /** Shared rate limiter from createLimiter, for many servers in one process. */
  limiter?: Limiter;
}

export interface GeminiCount {
  model: string;
  /** Tokens the tool definitions add to a request. */
  tokens: number;
}

/** The answer when Gemini refuses to count, for example on a schema it does not accept. */
export class GeminiCountError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'GeminiCountError';
  }
}

const MARKER = { name: 'mcpcost_marker', description: 'marker', parametersJsonSchema: { type: 'object', properties: {} } };
const CONTENTS = [{ role: 'user', parts: [{ text: 'hi' }] }];

/** Gemini function names: letters, digits, underscores, colons, dots and dashes, at most 64 characters. */
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_:.-]/g, '_').slice(0, 64) || 'tool';

/** The tool list as a Gemini function declaration list. Names are made safe and unique. */
export function toGeminiDeclarations(tools: ToolLike[]): Array<{ name: string; description: string; parametersJsonSchema: unknown }> {
  const seen = new Map<string, number>();
  return tools.map((t) => {
    let name = safeName(t.name);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name.slice(0, 60)}_${n + 1}`;
    return {
      name,
      // The field is required; an empty description is sent as a space.
      description: t.description || ' ',
      parametersJsonSchema: (t.inputSchema as object | undefined) ?? { type: 'object', properties: {} }
    };
  });
}

async function countRequest(model: string, declarations: object[], options: GeminiCountOptions): Promise<number> {
  const doFetch = options.fetch ?? fetch;
  const retries = options.retries ?? 5;
  const body = { generateContentRequest: { model: `models/${model}`, contents: CONTENTS, tools: [{ functionDeclarations: declarations }] } };
  for (let attempt = 0; ; attempt++) {
    if (options.limiter) await options.limiter.wait();
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_URL}/${model}:countTokens`, {
        method: 'POST',
        headers: { 'x-goog-api-key': options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new GeminiCountError(e instanceof Error ? e.message : String(e), 0);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as { totalTokens?: number; error?: { message?: string } };
    if (!res.ok) throw new GeminiCountError((json.error?.message ?? `HTTP ${res.status}`).slice(0, 300), res.status);
    return json.totalTokens ?? 0;
  }
}

const baselines = new Map<string, Promise<number>>();

/** Tokens of the message plus the marker function, once per model and process. */
function baseline(model: string, options: GeminiCountOptions): Promise<number> {
  let p = baselines.get(model);
  if (!p) {
    p = countRequest(model, [MARKER], options);
    p.catch(() => baselines.delete(model));
    baselines.set(model, p);
  }
  return p;
}

/** Exact tokens these tool definitions add to a request for this model. */
export async function countGeminiTokens(tools: ToolLike[], options: GeminiCountOptions): Promise<GeminiCount> {
  const model = options.model ?? GEMINI_MODEL;
  if (!tools.length) return { model, tokens: 0 };
  const base = await baseline(model, options);
  const withTools = await countRequest(model, [MARKER, ...toGeminiDeclarations(tools)], options);
  return { model, tokens: Math.max(0, withTools - base) };
}
