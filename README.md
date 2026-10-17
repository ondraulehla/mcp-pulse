# mcpcost

[![CI](https://github.com/ondraulehla/mcpcost/actions/workflows/ci.yml/badge.svg)](https://github.com/ondraulehla/mcpcost/actions/workflows/ci.yml) [![npm mcpcost](https://img.shields.io/npm/v/mcpcost?label=mcpcost)](https://www.npmjs.com/package/mcpcost) [![license](https://img.shields.io/github/license/ondraulehla/mcpcost)](LICENSE) [![Glama](https://glama.ai/mcp/servers/ondraulehla/mcpcost/badges/score.svg)](https://glama.ai/mcp/servers/ondraulehla/mcpcost)

**Is that MCP server alive, and what does it cost your context window?**

**Live board: [mcpcost.ulehla.dev](https://mcpcost.ulehla.dev)**

mcpcost probes every remote server in the [official MCP registry](https://registry.modelcontextprotocol.io) and records, for each one:

- whether it answers `initialize` and `tools/list`, and how fast
- the protocol version it negotiates
- whether it needs auth, and which scheme (from `WWW-Authenticate`)
- whether it asks for payment (HTTP 402)
- how many tools it has and how many tokens their definitions cost

## mcpcost: what do your own servers cost?

```bash
npx mcpcost                     # reads Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI configs
npx mcpcost --config .mcp.json  # one file
npx mcpcost --budget 30000      # exit 1 when the total is above the budget, for CI
npx mcpcost --claude            # exact counts from the Anthropic count_tokens endpoint (free, needs ANTHROPIC_API_KEY)
npx mcpcost mcp                 # the same measurements as an MCP server over stdio, for your agent
```

It starts every configured server the way your client does, lists the tools and prints the token cost per server and in total. See [packages/mcpcost](packages/mcpcost/README.md).

### In CI, as a GitHub Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-mcpcost-e8571f?logo=github)](https://github.com/marketplace/actions/mcpcost-token-budget-for-mcp-servers)

```yaml
- uses: ondraulehla/mcpcost@v1
  with:
    config: .mcp.json   # one or more config files, one per line
    budget: 30000       # fail when the tool definitions cost more than this
```

The job summary gets a table with every server, its result and its cost, plus the most expensive tools. A pull request that adds a 40 000-token server fails the check. Set `claude: true` and put `ANTHROPIC_API_KEY` in `env` for exact counts from the free count_tokens endpoint; the default is the o200k_base estimate. Outputs: `tokens`, `servers`, `over-budget`.

On a pull request the action also measures the same config files on the base branch and posts one comment with the difference: servers added, removed and changed, the token delta per server, the new total and the budget verdict. The comment is updated on every push, never duplicated. The job needs `pull-requests: write` for it; without that permission the step warns and the check still runs. Set `comment: false` to turn it off. A complete workflow is in [.github/examples/mcp-budget.yml](.github/examples/mcp-budget.yml).

### In Claude Code, as a plugin

In a Claude Code session:

```
/plugin install mcpcost --marketplace ondraulehla/mcpcost
```

Or from the shell: `claude plugin marketplace add ondraulehla/mcpcost`, then `claude plugin install mcpcost@mcpcost`.

The plugin adds one skill, `/mcpcost:measure`, which runs `npx mcpcost` on your configs and reads the result, and the board's MCP server, so Claude can look up or probe a server before it goes into a config. What the plugin itself costs: one skill description in the context, and four tools that Claude Code defers behind tool search.

## The board

[mcpcost.ulehla.dev](https://mcpcost.ulehla.dev) is rendered on the edge from a D1 database and refreshes every night. The only scripts it loads are a theme switch and the Cloudflare Web Analytics beacon, which counts page views without cookies.

- **Overview**: the share of servers that answer, token cost percentiles, and a form to check any server
- **Check**: probes one URL live, with the same steps as the daily run; the exact token count runs in the browser
- **Statistics**: results by cause, token cost and tool count percentiles, the heaviest tool sets, protocol versions, auth schemes, transports, biggest publishers
- **Servers**: full-text search over name, title, description and host (word prefixes, so `git copilot` finds the GitHub Copilot servers), filters by result, protocol and transport, seven sorts, and every filter is a plain URL you can share
- **Server page**: status, latency, protocol, capabilities, the most expensive tools, servers with the same tool set, history, the badge, and e-mail alerts: a mail when the server stops answering, comes back, or its tool set or token cost changes
- **Track**: a server that is not in the registry can be tracked from the check page; the daily probe then measures it under the name `url/<host>/<path>`
- **Hosts**: the 500 biggest publishers with how many distinct tool sets they actually serve

## For agents and scripts

- JSON: `/api/s/<name>.json`, `/api/servers.json?q=…&status=ok&sort=tokens`, `/api/check.json?url=…`, `/api/summary.json`
- MCP server over Streamable HTTP, no auth: `https://mcpcost.ulehla.dev/mcp` with the tools `lookup_server`, `search_servers`, `check_server`, `registry_summary`. The manifest for the registry is `site/server.json`.
- `/llms.txt` lists all of it. `/tokens` answers the general question: how many context tokens does an MCP server cost.

Each server on the board gets a page and a badge:

```markdown
[![mcpcost](https://mcpcost.ulehla.dev/badge/io.github.you/your-server.svg)](https://mcpcost.ulehla.dev/s/io.github.you/your-server)
```

## First full run, 2026-10-03

The registry held 38 942 latest entries. 24 294 of them have a remote endpoint, and the probe connected to all of them in 40 minutes.

| Result | Servers | Share |
|---|---:|---:|
| alive: `initialize` and `tools/list` succeed | 12 975 | 53 % |
| needs auth (401, 403) | 5 836 | 24 % |
| not MCP: HTTP 200 but no valid MCP reply | 1 800 | 7 % |
| not found (404, 405, 410) | 881 | 4 % |
| no DNS | 728 | 3 % |
| rate limited (429) | 500 | 2 % |
| payment required (402) | 434 | 2 % |
| server error (5xx) | 349 | 1 % |
| other | 307 | 1 % |
| TLS error | 259 | 1 % |
| timeout | 204 | 1 % |
| refused | 21 | 0 % |

Of the 12 975 servers that answered:

- the median tool set costs 1 727 tokens, the 90th percentile 7 429, the 99th 28 200
- 208 servers cost more than 20 000 tokens, 46 more than 50 000, and 3 more than a whole 200k window
- the heaviest is `com.replynodes/mcp`: 66 tools, 431 925 tokens
- the median server has 8 tools, the largest 1 385
- median `initialize` latency is 455 ms, the 90th percentile 1.5 s
- 60 % negotiate protocol `2025-11-25`, 24 % still `2025-03-26`, 4 % `2024-11-05`
- 122 servers answer with protocol `2026-07-28`, which the current TypeScript SDK rejects

The registry is lumpy. 16 161 of 16 534 hosts publish one server. Five hosts publish more than 6 000 entries between them: one Workers subdomain with 2 365 near-identical entries, a gateway with 1 716 entries of which 1 321 return a JSON-RPC error on `initialize`, and a host with 276 entries that all answer 402.

## How it works

```
registry ──▶ probe/run.ts ──▶ data/raw/probe-run.json
                                   │
                        probe/build-data.ts
                                   │
               data/latest/{servers,summary,hosts}.json
                                   │
                           probe/to-sql.ts ──▶ import.sql ──▶ D1
                                                                │
                              site/ (Astro on Workers) ◀────────┘
```

- `packages/mcpcost/` the library and the CLI `mcpcost`: registry client, remote and stdio probe, config discovery, token counting
- `probe/` the batch runner and the data pipeline
- `site/` the board: Astro 7 with the Cloudflare adapter on Workers, rendered from D1 with FTS5 search, SVG badges, no client JavaScript beyond the theme switch and the analytics beacon
- `.github/workflows/probe.yml` runs the whole pipeline daily and commits `summary.json` and `hosts.json`
- `.github/workflows/deploy.yml` deploys the site when `site/` changes

## Methodology

- **Transport.** The probe uses the official TypeScript SDK as a client. Streamable HTTP first, SSE when that is the only remote.
- **No GET stream.** The probe answers 405 to the SDK's standalone GET, so it never opens a server-to-client stream. The probe needs no server-initiated messages, and some servers stall `tools/list` while that stream is open (DeepWiki held it for 15 s and never answered the POST meanwhile).
- **Exact token count.** The daily run asks the Anthropic `count_tokens` endpoint for every alive server, and the Gemini `countTokens` endpoint when `GEMINI_API_KEY` is set (the CLI: `--gemini`). Anthropic first: one request with the server's tools plus a marker tool, one with the marker tool only, and the difference is what the tools cost in `claude-opus-5-5`. A second count uses Claude Code's `mcp__<server>__` prefix on each tool name. The endpoint is free and calls no model. A server is counted again only when its tool definitions change. About 5 % of servers publish a schema the endpoint refuses; they show the estimate and the reason.
- **Estimate.** Each tool is serialised as compact JSON with `name`, `description` and `input_schema`, and counted with the `o200k_base` tokenizer. The exact count is about 1.9 times the estimate at the median. The estimate needs no key and is the same for every server.
- **Same tool set.** A hash of the sorted tool names and schema sizes marks servers that serve identical tools under different names.
- **Timeouts.** 15 seconds per request. At most one probe runs against a host at a time.
- **Identification.** Every request carries the User-Agent `mcpcost/<version> (+https://github.com/ondraulehla/mcpcost)`. To exclude a server, open an issue with its registry name.

## Run it

```bash
npm install
npm run probe -- --sample 200 --per-host 2        # a sample, results in data/samples/
npm run probe -- --all --out data/raw/probe-run.json
node --import tsx probe/build-data.ts --in data/raw/probe-run.json --out data/latest
node --import tsx probe/to-sql.ts --in data/latest --out data/latest/import.sql
npm test --workspaces --if-present
```

Site, locally against a local D1:

```bash
cd site
npm run db:schema:local && npm run db:import:local
npm run dev
```

Deploying needs a Cloudflare account with a D1 database named `mcpcost` (`wrangler d1 create mcpcost`, then put the id in `site/wrangler.jsonc`). The workflows expect the repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, D1: Edit) and `CLOUDFLARE_ACCOUNT_ID`.

## Licence

MIT
