import { probeRemoteRaw, type CoreOptions, type RawTool } from './core.js';
import { toolsCost } from './tokens.js';
import type { ProbeResult, RemoteTransport } from './types.js';

export { VERSION, USER_AGENT, emptyResult, measure, classify } from './core.js';
export type { RawTool, RawProbe } from './core.js';

export interface ProbeOptions extends CoreOptions {
  /** Keep the per-tool list in the result. Default true. */
  includeTools?: boolean;
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
  return priceTools(result, tools, options.includeTools ?? true);
}
