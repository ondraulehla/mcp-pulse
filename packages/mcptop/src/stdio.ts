import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { emptyResult, measure, priceTools, type ProbeOptions } from './probe.js';
import type { ProbeResult } from './types.js';

export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Starts a local MCP server over stdio, lists its tools and measures what it costs. */
export async function probeStdio(target: StdioTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
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
  priceTools(result, tools, options.includeTools ?? true);

  if (result.status !== 'ok') {
    const stderr = stderrChunks.join('').trim();
    const text = `${result.error ?? ''} ${stderr}`;
    if (/ENOENT/.test(text)) {
      result.status = 'not_found';
      result.error = `command not found: ${target.command}`;
    } else if (/timed? ?out|TimeoutError/i.test(text)) {
      result.status = 'timeout';
    } else {
      result.status = /JSON|parse|Unexpected token/i.test(text) ? 'protocol_error' : 'error';
    }
    if (stderr && result.status !== 'not_found') result.error = `${result.error ?? ''}\n${stderr.slice(-400)}`.trim();
  }
  return result;
}
