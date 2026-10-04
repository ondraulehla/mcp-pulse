import { env } from 'cloudflare:workers';
import { countForServer, ClaudeCountError, CLAUDE_MODEL } from '../../../packages/mcptop/src/claude.ts';
import { payloadBytes, type ToolLike } from '../../../packages/mcptop/src/payload.ts';

export interface LiveClaudeCount {
  model: string;
  tokens?: number;
  tokensClaudeCode?: number;
  error?: string;
}

/** Tool payloads above this size are not sent to the counter. */
const MAX_BYTES = 4_000_000;

/**
 * Exact count for a live check. Uses the free count_tokens endpoint with the
 * Worker's ANTHROPIC_API_KEY secret. Returns null when there is no key, so the
 * page falls back to the estimate. Never calls a model.
 */
export async function liveClaudeCount(tools: ToolLike[], serverName: string): Promise<LiveClaudeCount | null> {
  const apiKey = (env as unknown as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!tools.length) return { model: CLAUDE_MODEL, tokens: 0, tokensClaudeCode: 0 };
  const bytes = tools.reduce((a, t) => a + payloadBytes(t), 0);
  if (bytes > MAX_BYTES) return { model: CLAUDE_MODEL, error: 'tool definitions above 4 MB are not counted live' };
  try {
    return await countForServer(tools, serverName, { apiKey, retries: 1, timeoutMs: 8_000 });
  } catch (e) {
    return { model: CLAUDE_MODEL, error: e instanceof ClaudeCountError ? e.message : 'count_tokens did not answer' };
  }
}
