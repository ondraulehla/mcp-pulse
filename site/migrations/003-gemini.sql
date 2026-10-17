-- Exact Gemini token counts. Apply once to a database created before 2026-10-17:
--   npx wrangler d1 execute mcp-pulse --remote --file=migrations/003-gemini.sql
ALTER TABLE servers ADD COLUMN gemini_model TEXT;
ALTER TABLE servers ADD COLUMN gemini_tokens INTEGER;
ALTER TABLE servers ADD COLUMN gemini_measured_at TEXT;
ALTER TABLE servers ADD COLUMN gemini_error TEXT;
