import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import type { ToolCost } from './types.js';

/** The tokenizer used for every count. Stated in the methodology. */
export const TOKENIZER = 'o200k_base';

export interface ToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

/**
 * Serialises a tool the way a client sends it to a model: name, description and
 * input schema, as compact JSON. Different clients wrap this differently, so the
 * count is an estimate, and it is the same estimate for every server.
 */
export function toolPayload(tool: ToolLike): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object' }
  });
}

export function countTokens(text: string): number {
  return encode(text).length;
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
