/** The shape a tool takes when a client hands it to a model. No tokenizer here, so the Worker can import it. */
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

export function payloadBytes(tool: ToolLike): number {
  return new TextEncoder().encode(toolPayload(tool)).length;
}

/** Median bytes per token over 12 968 measured servers (p10 4.03, p90 4.62). For estimates without the tokenizer. */
export const BYTES_PER_TOKEN = 4.42;
