import { describe, expect, it } from 'vitest';
import { countGeminiTokens, GeminiCountError, toGeminiDeclarations } from '../src/gemini.js';

/** A fake countTokens: 10 tokens per declaration plus 1 per character of every name, plus 30 for the message. */
function fakeFetch(calls: object[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { generateContentRequest: { model: string; tools: Array<{ functionDeclarations: Array<{ name: string }> }> } };
    calls.push(body);
    const decls = body.generateContentRequest.tools[0].functionDeclarations;
    const n = 30 + decls.reduce((a, t) => a + 10 + t.name.length, 0);
    return new Response(JSON.stringify({ totalTokens: n }), { status: 200 });
  }) as typeof fetch;
}

const tools = [
  { name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list dir!', description: '' }
];

describe('toGeminiDeclarations', () => {
  it('cleans names, sends the JSON schema as it is and never an empty description', () => {
    expect(toGeminiDeclarations(tools)).toEqual([
      { name: 'read_file', description: 'Reads a file.', parametersJsonSchema: tools[0].inputSchema },
      { name: 'list_dir_', description: ' ', parametersJsonSchema: { type: 'object', properties: {} } }
    ]);
  });

  it('makes duplicate names unique', () => {
    const names = toGeminiDeclarations([{ name: 'a' }, { name: 'a' }, { name: 'a' }]).map((d) => d.name);
    expect(names).toEqual(['a', 'a_2', 'a_3']);
  });
});

describe('countGeminiTokens', () => {
  it('subtracts the marker-only baseline and names the model in the request', async () => {
    const calls: Array<{ generateContentRequest: { model: string } }> = [];
    const c = await countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-a', fetch: fakeFetch(calls) });
    // two tools: 10 + 9 ('read_file') + 10 + 9 ('list_dir_') = 38
    expect(c).toEqual({ model: 'test-gemini-a', tokens: 38 });
    expect(calls).toHaveLength(2);
    expect(calls[0].generateContentRequest.model).toBe('models/test-gemini-a');
  });

  it('reuses the baseline for the same model', async () => {
    const calls: object[] = [];
    await countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-b', fetch: fakeFetch(calls) });
    await countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-b', fetch: fakeFetch(calls) });
    expect(calls).toHaveLength(3);
  });

  it('returns zero for no tools without a request', async () => {
    const calls: object[] = [];
    expect(await countGeminiTokens([], { apiKey: 'k', model: 'test-gemini-c', fetch: fakeFetch(calls) })).toEqual({ model: 'test-gemini-c', tokens: 0 });
    expect(calls).toHaveLength(0);
  });

  it('throws a GeminiCountError with the status on a refused schema', async () => {
    const refusing = (async () => new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON schema', status: 'INVALID_ARGUMENT' } }), { status: 400 })) as typeof fetch;
    await expect(countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-d', fetch: refusing, retries: 0 })).rejects.toMatchObject({ status: 400, message: /Invalid JSON schema/ });
    await expect(countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-d', fetch: refusing, retries: 0 })).rejects.toBeInstanceOf(GeminiCountError);
  });

  it('retries on 429', async () => {
    let n = 0;
    const flaky = (async (_u: string | URL | Request, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return fakeFetch()(_u, init);
    }) as typeof fetch;
    const c = await countGeminiTokens(tools, { apiKey: 'k', model: 'test-gemini-e', fetch: flaky, retries: 2 });
    expect(c.tokens).toBe(38);
    expect(n).toBe(3);
  });
});
