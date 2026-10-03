// A tiny MCP server over stdio for the tests. Two tools, one instruction.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '0.1.0' }, { instructions: 'Fixture.' });
server.registerTool('add', { description: 'Adds two numbers.', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }]
}));
server.registerTool('env', { description: 'Returns FIXTURE_FLAG.' }, async () => ({
  content: [{ type: 'text', text: process.env.FIXTURE_FLAG ?? '' }]
}));
if (process.env.FIXTURE_FLAG === 'noisy') console.error('fixture: starting');
await server.connect(new StdioServerTransport());
