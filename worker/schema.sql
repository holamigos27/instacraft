-- instaCRAFT shared data (Cloudflare D1). Kept apart from CRAQUES HUB's Turso on purpose:
-- whatever happens here can never stop the attendance system.
CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,              -- post | preset
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}', -- the document as JSON (images referenced by URL)
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,             -- ic + sha256(base64) prefix: same image, same id
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  reg TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS used_tickets (
  jti TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fonts (
  id TEXT PRIMARY KEY,             -- f + sha256(file) prefix
  family TEXT NOT NULL,            -- the name it is used by in designs
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS font_chunks (
  id TEXT NOT NULL,                -- the font's id
  idx INTEGER NOT NULL,            -- a font is kept in chunks of up to 1.5 MB (a D1 row holds 2 MB)
  data BLOB NOT NULL,
  PRIMARY KEY (id, idx)
);
