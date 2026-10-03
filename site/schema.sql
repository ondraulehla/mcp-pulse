-- mcp-pulse D1 schema. Apply with:
--   npx wrangler d1 execute mcp-pulse --local --file=schema.sql
--   npx wrangler d1 execute mcp-pulse --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS runs (
  probed_at TEXT PRIMARY KEY,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  name TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  transport TEXT NOT NULL,
  repo TEXT,
  website TEXT,
  registry_status TEXT,
  registry_updated_at TEXT,
  probed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  auth_scheme TEXT,
  protocol_version TEXT,
  server_name TEXT,
  server_version TEXT,
  capabilities TEXT,
  init_ms INTEGER,
  tools_ms INTEGER,
  tool_count INTEGER,
  tools_tokens INTEGER,
  instructions_chars INTEGER,
  toolset_hash TEXT,
  toolset_siblings INTEGER,
  top_tools TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS servers_status ON servers (status);
CREATE INDEX IF NOT EXISTS servers_host ON servers (host);
CREATE INDEX IF NOT EXISTS servers_tokens ON servers (tools_tokens);
CREATE INDEX IF NOT EXISTS servers_toolset ON servers (toolset_hash);

CREATE TABLE IF NOT EXISTS probes (
  name TEXT NOT NULL,
  probed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  init_ms INTEGER,
  tool_count INTEGER,
  tools_tokens INTEGER,
  PRIMARY KEY (name, probed_at)
);

CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  servers INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  auth INTEGER NOT NULL,
  dead INTEGER NOT NULL,
  unique_toolsets INTEGER NOT NULL,
  median_tokens INTEGER,
  probed_at TEXT NOT NULL
);
