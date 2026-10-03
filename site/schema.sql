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

-- Indexes that let the list page read only the rows it shows. Directions match
-- the ORDER BY clauses in src/lib/db.ts so SQLite needs no temp sort.
CREATE INDEX IF NOT EXISTS servers_tokens_name ON servers (tools_tokens DESC, name);
CREATE INDEX IF NOT EXISTS servers_status_tokens ON servers (status, tools_tokens DESC, name);
CREATE INDEX IF NOT EXISTS servers_host_tokens ON servers (host, tools_tokens DESC, name);
CREATE INDEX IF NOT EXISTS servers_protocol_tokens ON servers (protocol_version, tools_tokens DESC, name);
CREATE INDEX IF NOT EXISTS servers_tools_name ON servers (tool_count DESC, name);
CREATE INDEX IF NOT EXISTS servers_status_tools ON servers (status, tool_count DESC, name);
CREATE INDEX IF NOT EXISTS servers_init_name ON servers (init_ms, name);
CREATE INDEX IF NOT EXISTS servers_status_init ON servers (status, init_ms, name);
CREATE INDEX IF NOT EXISTS servers_updated_name ON servers (registry_updated_at DESC, name);
CREATE INDEX IF NOT EXISTS servers_status_updated ON servers (status, registry_updated_at DESC, name);
DROP INDEX IF EXISTS servers_tokens;

-- Full-text search over the columns people search by. The content table is
-- servers, so the FTS index stores only tokens. Triggers keep it in step; the
-- importer uses INSERT ... ON CONFLICT DO UPDATE, because REPLACE would not fire
-- the delete trigger. After creating it on a database that already has rows, run
-- once: INSERT INTO servers_fts(servers_fts) VALUES ('rebuild');
CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
  name, title, description, host, server_name,
  content='servers', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers BEGIN
  INSERT INTO servers_fts(rowid, name, title, description, host, server_name)
  VALUES (new.rowid, new.name, new.title, new.description, new.host, new.server_name);
END;
CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, host, server_name)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.host, old.server_name);
END;
CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, host, server_name)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.host, old.server_name);
  INSERT INTO servers_fts(rowid, name, title, description, host, server_name)
  VALUES (new.rowid, new.name, new.title, new.description, new.host, new.server_name);
END;
