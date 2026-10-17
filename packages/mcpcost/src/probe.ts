import { probeRemoteRaw, type CoreOptions, type RawTool } from './core.js';
import { toolsCost } from './tokens.js';
import { countForServer, ClaudeCountError, CLAUDE_MODEL } from './claude.js';
import { countGeminiTokens, GeminiCountError, GEMINI_MODEL } from './gemini.js';
import type { ProbeResult, RemoteTransport } from './types.js';

export { VERSION, USER_AGENT, emptyResult, measure, classify } from './core.js';
export type { RawTool, RawProbe } from './core.js';

export interface ClaudeOptions {
  /** Anthropic API key. Only the free count_tokens endpoint is called. */
  apiKey: string;
  /** Model id. Default claude-opus-5-5. */
  model?: string;
  /** The server key in the client config, for the Claude Code mcp__<server>__ prefix. Default: the host or the command. */
  serverName?: string;
}

export interface GeminiOptions {
  /** Gemini API key. Only the free countTokens endpoint is called. */
  apiKey: string;
  /** Model id. Default gemini-3.8-flash. */
  model?: string;
}

export interface ProbeOptions extends CoreOptions {
  /** Keep the per-tool list in the result. Default true. */
  includeTools?: boolean;
  /** Also ask the Anthropic count_tokens endpoint for the exact count. */
  claude?: ClaudeOptions;
  /** Also ask the Gemini countTokens endpoint for the exact count. */
  gemini?: GeminiOptions;
}

/** Adds the exact Gemini count to an alive result. A refused schema becomes `gemini.error`; a transport failure leaves `gemini` empty. */
export async function attachGemini(result: ProbeResult, tools: RawTool[], gemini: GeminiOptions | undefined): Promise<ProbeResult> {
  if (!gemini || result.status !== 'ok') return result;
  const measuredAt = new Date().toISOString();
  try {
    const c = await countGeminiTokens(tools, { apiKey: gemini.apiKey, model: gemini.model });
    result.gemini = { model: c.model, tokens: c.tokens, measuredAt };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof GeminiCountError && e.status >= 400 && e.status < 500 && e.status !== 429) result.gemini = { model: gemini.model ?? GEMINI_MODEL, measuredAt, error: message };
  }
  return result;
}

/** Adds the exact Claude count to an alive result. A refused schema becomes `claude.error`; a transport failure leaves `claude` empty. */
export async function attachClaude(result: ProbeResult, tools: RawTool[], claude: ClaudeOptions | undefined): Promise<ProbeResult> {
  if (!claude || result.status !== 'ok') return result;
  const measuredAt = new Date().toISOString();
  const serverName = claude.serverName ?? result.url.replace(/^stdio:/, '').replace(/^https?:\/\//, '').split(/[/\s]/)[0];
  try {
    const c = await countForServer(tools, serverName, { apiKey: claude.apiKey, model: claude.model });
    result.claude = { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof ClaudeCountError && e.status >= 400 && e.status < 500 && e.status !== 429) result.claude = { model: claude.model ?? CLAUDE_MODEL, measuredAt, error: message };
  }
  return result;
}

/** Adds the token cost of the listed tools to a probe result. */
export function priceTools(result: ProbeResult, tools: RawTool[], includeTools = true): ProbeResult {
  if (result.status !== 'ok') return result;
  const cost = toolsCost(tools);
  result.toolCount = tools.length;
  result.toolsTokens = cost.tokens;
  result.toolsBytes = cost.bytes;
  if (includeTools) result.tools = cost.tools;
  return result;
}

/** Connects to a remote MCP server, lists its tools and measures what it costs. */
export async function probeRemote(remote: { url: string; type: RemoteTransport }, options: ProbeOptions = {}): Promise<ProbeResult> {
  const { result, tools } = await probeRemoteRaw(remote, options);
  priceTools(result, tools, options.includeTools ?? true);
  await attachClaude(result, tools, options.claude);
  return attachGemini(result, tools, options.gemini);
}
