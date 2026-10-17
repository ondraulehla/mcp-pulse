/**
 * Exact Gemini counts with a cache, the same way as claude-cache.ts: a server
 * is counted again only when its tool payload changed. The cache is the
 * previous run's servers.json.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { countGeminiTokens, createLimiter, GeminiCountError, GEMINI_MODEL } from '../packages/mcpcost/src/index.js';
import type { GeminiTokens } from '../packages/mcpcost/src/index.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';

type CachedGemini = GeminiTokens & { payloadHash?: string };

export interface GeminiCounter {
  enabled: boolean;
  count(name: string, tools: RawTool[], hash: string): Promise<GeminiTokens | undefined>;
  stats(): { counted: number; reused: number; skipped: number };
}

export async function createGeminiCounter(options: { apiKey?: string; cachePath?: string; model?: string; rpm?: number; deadline?: number }): Promise<GeminiCounter> {
  const apiKey = options.apiKey;
  const model = options.model ?? GEMINI_MODEL;
  const cache = new Map<string, CachedGemini>();
  if (options.cachePath && existsSync(options.cachePath)) {
    const prev = JSON.parse(await readFile(options.cachePath, 'utf8')) as Array<{ name: string; payloadHash?: string; geminiModel?: string; geminiTokens?: number; geminiMeasuredAt?: string; geminiError?: string }>;
    for (const p of prev) {
      if (p.payloadHash && p.geminiModel === model && p.geminiMeasuredAt && (p.geminiTokens != null || p.geminiError)) {
        cache.set(p.name, { payloadHash: p.payloadHash, model: p.geminiModel, tokens: p.geminiTokens, measuredAt: p.geminiMeasuredAt, error: p.geminiError });
      }
    }
    console.error(`${cache.size} Gemini counts loaded from ${options.cachePath}`);
  }
  const limiter = createLimiter(options.rpm ?? 60);
  const deadline = options.deadline ?? Infinity;
  let counted = 0, reused = 0, skipped = 0;
  return {
    enabled: Boolean(apiKey),
    stats: () => ({ counted, reused, skipped }),
    async count(name, tools, hash) {
      if (!apiKey) return undefined;
      const cached = cache.get(name);
      if (cached && cached.payloadHash === hash) {
        reused++;
        const { payloadHash: _h, ...rest } = cached;
        return rest;
      }
      if (Date.now() > deadline) { skipped++; return undefined; }
      counted++;
      const measuredAt = new Date().toISOString();
      try {
        const c = await countGeminiTokens(tools, { apiKey, model, limiter });
        if (cached && cached.tokens === c.tokens) return { model: c.model, tokens: c.tokens, measuredAt: cached.measuredAt };
        return { model: c.model, tokens: c.tokens, measuredAt };
      } catch (e) {
        const message = e instanceof GeminiCountError ? e.message : String(e);
        // A refused schema is a stable fact about the server; a transport failure is not, so leave it out and retry next run.
        if (e instanceof GeminiCountError && e.status >= 400 && e.status < 500 && e.status !== 429) return { model, measuredAt, error: message };
        console.error(`  countTokens failed for ${name}: ${message}`);
        return undefined;
      }
    }
  };
}
