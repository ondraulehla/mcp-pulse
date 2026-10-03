import { describe, expect, it } from 'vitest';
import { countTokens, toolCost, toolPayload, toolsCost } from '../src/tokens.js';

const echo = {
  name: 'echo',
  description: 'Returns the input text unchanged.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
};

describe('toolPayload', () => {
  it('serialises name, description and input_schema as compact JSON', () => {
    expect(JSON.parse(toolPayload(echo))).toEqual({
      name: 'echo',
      description: 'Returns the input text unchanged.',
      input_schema: echo.inputSchema
    });
    expect(toolPayload(echo)).not.toContain('\n');
  });

  it('fills in an empty description and an empty object schema', () => {
    expect(JSON.parse(toolPayload({ name: 'bare' }))).toEqual({
      name: 'bare',
      description: '',
      input_schema: { type: 'object' }
    });
  });
});

describe('toolCost', () => {
  it('counts the same payload the same way every time', () => {
    const a = toolCost(echo);
    const b = toolCost(echo);
    expect(a).toEqual(b);
    expect(a.tokens).toBeGreaterThan(10);
    expect(a.bytes).toBe(Buffer.byteLength(toolPayload(echo)));
    expect(a.descriptionChars).toBe(echo.description.length);
  });

  it('charges more for a longer description', () => {
    const verbose = { ...echo, description: echo.description.repeat(20) };
    expect(toolCost(verbose).tokens).toBeGreaterThan(toolCost(echo).tokens);
  });

  it('sums over all tools', () => {
    const total = toolsCost([echo, { name: 'bare' }]);
    expect(total.tools).toHaveLength(2);
    expect(total.tokens).toBe(total.tools[0].tokens + total.tools[1].tokens);
    expect(total.bytes).toBe(total.tools[0].bytes + total.tools[1].bytes);
  });
});

describe('countTokens', () => {
  it('returns zero for an empty string and grows with the text', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello world')).toBeLessThan(countTokens('hello world, hello world, hello world'));
  });
});
