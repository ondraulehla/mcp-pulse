import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyResult, measure, priceTools, attachClaude, attachGemini, type ProbeOptions } from './probe.js';
import type { RawTool } from './core.js';
import type { ProbeResult } from './types.js';

export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Starts a local MCP server over stdio, lists its tools and measures what it costs. */
export async function probeStdio(target: StdioTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const { result, tools } = await probeStdioRaw(target, options);
  priceTools(result, tools, options.includeTools ?? true);
  await attachClaude(result, tools, options.claude);
  await attachGemini(result, tools, options.gemini);
  return result;
}

/** The same, with the tool definitions as the server sent them, for callers that count tokens their own way. */
export async function probeStdioRaw(target: StdioTarget, options: ProbeOptions = {}): Promise<{ result: ProbeResult; tools: RawTool[] }> {
  const label = [target.command, ...(target.args ?? [])].join(' ');
  const result = emptyResult(`stdio:${label}`, 'stdio');
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    cwd: target.cwd,
    env: { ...getDefaultEnvironment(), ...(target.env ?? {}) },
    stderr: 'pipe'
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderrChunks.join('').length < 2_000) stderrChunks.push(chunk.toString('utf8'));
  });

  const tools = await measure(transport, result, options.timeoutMs ?? 15_000);

  if (result.status !== 'ok') {
    const stderr = stderrChunks.join('').trim();
    const text = `${result.error ?? ''} ${stderr}`;
    // Only the transport's own ENOENT means the command is missing; a server may print ENOENT about something else.
    if (/ENOENT/.test(result.error ?? '') || /spawn .* ENOENT/.test(stderr)) {
      result.status = 'not_found';
      result.error = `command not found: ${target.command}`;
    } else if (/timed? ?out|TimeoutError/i.test(text)) {
      result.status = 'timeout';
    } else {
      result.status = /JSON|parse|Unexpected token/i.test(text) ? 'protocol_error' : 'error';
    }
    if (stderr && result.status !== 'not_found') result.error = `${result.error ?? ''}\n${stderr.slice(-400)}`.trim();
  }
  return { result, tools };
}
