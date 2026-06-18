CREATE TABLE IF NOT EXISTS team_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  author_key TEXT,
  body TEXT NOT NULL
);

-- AP11: id als TEXT fuer benannte Eintraege (ap8, ap9, ...)
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
