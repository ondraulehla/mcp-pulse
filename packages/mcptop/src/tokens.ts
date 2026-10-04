import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { toolPayload, type ToolLike } from './payload.js';
import type { ToolCost } from './types.js';

export { toolPayload, BYTES_PER_TOKEN } from './payload.js';
export type { ToolLike } from './payload.js';

/** The tokenizer used for every count. Stated in the methodology. */
export const TOKENIZER = 'o200k_base';

/**
 * Tool descriptions can contain strings such as <|im_start|> that look like
 * special tokens. They are plain text here, so no special token is allowed
 * and nothing is disallowed: the tokenizer encodes them as ordinary text.
 */
const PLAIN_TEXT = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };

export function countTokens(text: string): number {
  return encode(text, PLAIN_TEXT).length;
}

export function toolCost(tool: ToolLike): ToolCost {
  const payload = toolPayload(tool);
  return {
    name: tool.name,
    tokens: countTokens(payload),
    bytes: Buffer.byteLength(payload, 'utf8'),
    descriptionChars: (tool.description ?? '').length
  };
}

export function toolsCost(tools: ToolLike[]): { tools: ToolCost[]; tokens: number; bytes: number } {
  const costs = tools.map(toolCost);
  return {
    tools: costs,
    tokens: costs.reduce((sum, t) => sum + t.tokens, 0),
    bytes: costs.reduce((sum, t) => sum + t.bytes, 0)
  };
}
