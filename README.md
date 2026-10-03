# mcp-pulse

**Is that MCP server alive, and what does it cost your context window?**

mcp-pulse probes the remote servers in the [official MCP registry](https://registry.modelcontextprotocol.io) and records, for each one:

- whether it answers `initialize` and `tools/list`, and how fast
- the protocol version it negotiates
- whether it needs auth, and which scheme (from `WWW-Authenticate`)
- whether it asks for payment (HTTP 402)
- how many tools it has and how many tokens their definitions cost

The same engine will run as a CLI over your own MCP config, so you can see which server eats how much of your context window before the first prompt.

## Status

Week 1 of 3. The probe works and has run over a sample of the registry. The public board, the badges and the CLI come next. See `data/samples/` for raw results.

First sample, 2026-10-03, 200 remote servers, at most 2 per host:

| Result | Servers |
|---|---|
| ok | 123 |
| auth required (401, 403) | 53 |
| not found (404, 405, 410) | 8 |
| dns | 4 |
| protocol error (200, but not MCP) | 3 |
| other error | 3 |
| payment required (402) | 2 |
| tls | 2 |
| server error (5xx) | 1 |
| timeout | 1 |

Of the 123 servers that answered, the median tool-definition cost was 1 359 tokens, the 90th percentile 5 672 tokens, and the largest 56 537 tokens (121 tools). Median `initialize` latency was 424 ms.

The registry itself: 38 942 latest entries on 2026-10-03, 24 294 with a remote endpoint. Five hosts account for more than 6 000 of those entries.

## Methodology

- **Transport.** The probe uses the official TypeScript SDK as a client. Streamable HTTP first, SSE when that is the only remote.
- **No GET stream.** The probe answers 405 to the SDK's standalone GET, so it never opens a server-to-client stream. The probe needs no server-initiated messages, and some servers stall `tools/list` while that stream is open.
- **Token count.** Each tool is serialised as compact JSON with `name`, `description` and `input_schema`, and counted with the `o200k_base` tokenizer. Clients wrap tool definitions differently, so this is an estimate. It is the same estimate for every server, which makes the numbers comparable.
- **Timeouts.** 15 seconds per request and per probe.
- **Sampling.** Samples pick at most N servers per host so that one bulk publisher does not dominate.
- **Identification.** Every request carries the User-Agent `mcp-pulse/<version> (+https://github.com/ondraulehla/mcp-pulse)`. To exclude a server, open an issue.

## Run it

```bash
npm install
npm run probe -- --sample 200 --per-host 2
npm test --workspaces
```

Results land in `data/samples/`.

## Layout

- `packages/mcp-pulse/` the library and the CLI: registry client, probe, token counting
- `probe/` the batch runner that produces the data
- `data/` raw registry snapshots (ignored) and probe results

## Licence

MIT
