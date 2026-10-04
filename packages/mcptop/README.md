# mcptop

[![npm](https://img.shields.io/npm/v/mcptop)](https://www.npmjs.com/package/mcptop) [![CI](https://github.com/ondraulehla/mcp-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/ondraulehla/mcp-pulse/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/mcptop)](LICENSE)

**`top` for your MCP servers: how many tokens do their tool definitions cost before the first prompt?**

mcptop is the CLI of [mcp-pulse](https://github.com/ondraulehla/mcp-pulse), the board that probes every remote server in the official MCP registry. The board tells you about servers out there. mcptop tells you about yours.

Every MCP server you configure hands your agent its tool definitions at the start of each session. Those definitions are tokens, and you pay for them in every turn. This command starts each configured server, lists its tools and tells you what they cost.

```
$ npx mcptop --config .mcp.json --tools 3

mcptop 0.1.2 · tool definitions your agent loads before the first prompt
  .mcp.json

  server      source     result               tools  tokens  of 200k
  ──────────  ─────────  ───────────────────  ─────  ──────  ───────
  filesystem  .mcp.json  alive                   14   1 650    0.8 %
  everything  .mcp.json  alive                   13   1 075    0.5 %
  deepwiki    .mcp.json  alive                    3     239    0.1 %
  github      .mcp.json  needs auth (Bearer)
  apify       .mcp.json  needs auth (Bearer)
  ──────────  ─────────  ───────────────────  ─────  ──────  ───────
  total                  3 of 5 measured         30   2 964    1.5 %

  github: Streamable HTTP error: Error POSTing to endpoint: bad request: missing required Authorization header
  apify: Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token", ...

  filesystem: most expensive tools
        185  read_text_file
        162  edit_file
        148  search_files
```

That run measured this `.mcp.json`: the filesystem and everything reference servers over stdio, DeepWiki, the GitHub MCP and Apify over HTTP. Servers that need auth are reachable but not measured until you put the header in the config.

It reads the config files of Claude Code (`.mcp.json`, `~/.claude.json`), Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI. Remote servers are probed over Streamable HTTP or SSE with the headers from your config. Local servers are started over stdio with the command, args and env from your config, the same way your client starts them.

## Options

```
mcptop [options]                 measure every server in the configs it can find
mcptop --config <file>           measure one config file (repeatable)
mcptop --url <url>               measure one remote server (repeatable)
mcptop --stdio "<command args>"  measure one local server (repeatable)

--window <tokens>    context window for the percentages (default 200000)
--budget <tokens>    exit with code 1 when the total is above this
--tools <n>          list the n most expensive tools of each server
--timeout <ms>       per server (default 15000)
--no-stdio           do not start local servers, only measure remote ones
--json               machine-readable output
```

`--budget` makes it a CI check: commit your `.mcp.json`, run `npx mcptop --budget 30000` in the pipeline, and a pull request that adds a 40 000-token server fails.

## How tokens are counted

Each tool is serialised as compact JSON with `name`, `description` and `input_schema`, and counted with the `o200k_base` tokenizer. Clients wrap tool definitions in their own way and models tokenise differently, so the number is a floor, not an invoice. It is the same count for every server, which makes servers comparable, and it is the same count the [public board](https://mcp-pulse.ulehla.dev) uses for every remote server in the official registry.

## Library

```ts
import { probeRemote, probeStdio, discoverConfigs } from 'mcptop';

const r = await probeRemote({ url: 'https://mcp.deepwiki.com/mcp', type: 'streamable-http' });
r.status;       // 'ok' | 'auth' | 'payment' | 'not_found' | 'timeout' | ...
r.toolsTokens;  // 239
r.tools;        // [{ name, tokens, bytes, descriptionChars }, ...]
```

## Licence

MIT
