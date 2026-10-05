-- Exact Claude token counts. Apply once to a database created before 2026-10-04:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/002-claude.sql
-- The index writes one entry per server row, so apply it on a day with no other large import.
ALTER TABLE servers ADD COLUMN claude_model TEXT;
ALTER TABLE servers ADD COLUMN claude_tokens INTEGER;
ALTER TABLE servers ADD COLUMN claude_tokens_cc INTEGER;
ALTER TABLE servers ADD COLUMN claude_measured_at TEXT;
ALTER TABLE servers ADD COLUMN claude_error TEXT;
ALTER TABLE probes ADD COLUMN claude_tokens INTEGER;
-- Indexes: the daily workflow applies schema.sql, which creates and drops them.
-- The update trigger now fires only when a searchable column changed.
DROP TRIGGER IF EXISTS servers_au;
CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers
WHEN old.name IS NOT new.name OR old.title IS NOT new.title OR old.description IS NOT new.description OR old.host IS NOT new.host OR old.server_name IS NOT new.server_name
BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, host, server_name)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.host, old.server_name);
  INSERT INTO servers_fts(rowid, name, title, description, host, server_name)
  VALUES (new.rowid, new.name, new.title, new.description, new.host, new.server_name);
END;
