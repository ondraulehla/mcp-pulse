# mcp-pulse

**Is that MCP server alive, and what does it cost your context window?**

**Live board: [mcp-pulse.ondrejulehla.workers.dev](https://mcp-pulse.ondrejulehla.workers.dev)**

mcp-pulse probes every remote server in the [official MCP registry](https://registry.modelcontextprotocol.io) and records, for each one:

- whether it answers `initialize` and `tools/list`, and how fast
- the protocol version it negotiates
- whether it needs auth, and which scheme (from `WWW-Authenticate`)
- whether it asks for payment (HTTP 402)
- how many tools it has and how many tokens their definitions cost

## mcptop: what do your own servers cost?

```bash
npx mcptop                     # reads Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI configs
npx mcptop --config .mcp.json  # one file
npx mcptop --budget 30000      # exit 1 when the total is above the budget, for CI
```

It starts every configured server the way your client does, lists the tools and prints the token cost per server and in total. See [packages/mcptop](packages/mcptop/README.md).

Each server on the board gets a page and a badge:

```markdown
[![mcp-pulse](https://mcp-pulse.ondrejulehla.workers.dev/badge/io.github.you/your-server.svg)](https://mcp-pulse.ondrejulehla.workers.dev/s/io.github.you/your-server)
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

- `packages/mcptop/` the library and the CLI `mcptop`: registry client, remote and stdio probe, config discovery, token counting
- `probe/` the batch runner and the data pipeline
- `site/` the board: Astro 7 with the Cloudflare adapter, rendered from D1, with SVG badges
- `.github/workflows/probe.yml` runs the whole pipeline daily and commits `summary.json` and `hosts.json`
- `.github/workflows/deploy.yml` deploys the site when `site/` changes

## Methodology

- **Transport.** The probe uses the official TypeScript SDK as a client. Streamable HTTP first, SSE when that is the only remote.
- **No GET stream.** The probe answers 405 to the SDK's standalone GET, so it never opens a server-to-client stream. The probe needs no server-initiated messages, and some servers stall `tools/list` while that stream is open (DeepWiki held it for 15 s and never answered the POST meanwhile).
- **Token count.** Each tool is serialised as compact JSON with `name`, `description` and `input_schema`, and counted with the `o200k_base` tokenizer. Clients wrap tool definitions differently, so this is an estimate. It is the same estimate for every server, which makes the numbers comparable.
- **Same tool set.** A hash of the sorted tool names and schema sizes marks servers that serve identical tools under different names.
- **Timeouts.** 15 seconds per request. At most one probe runs against a host at a time.
- **Identification.** Every request carries the User-Agent `mcp-pulse/<version> (+https://github.com/ondraulehla/mcp-pulse)`. To exclude a server, open an issue with its registry name.

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

Deploying needs a Cloudflare account with a D1 database named `mcp-pulse` (`wrangler d1 create mcp-pulse`, then put the id in `site/wrangler.jsonc`). The workflows expect the repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, D1: Edit) and `CLOUDFLARE_ACCOUNT_ID`.

## Licence

MIT
