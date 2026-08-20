-- Research loop relational state.
-- Vectorize holds semantic memory; D1 holds everything that needs ordering,
-- queueing, or exact lookup.

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  topic          TEXT NOT NULL,
  goals          TEXT NOT NULL,          -- JSON array
  status         TEXT NOT NULL,          -- running | done | stopped | failed
  reason         TEXT,                   -- why it terminated
  iterations     INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL,
  report         TEXT,                   -- final synthesis
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Source queue. One row per URL; claimed one at a time per iteration.
CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | fetched | failed
  error      TEXT,
  chunks     INTEGER NOT NULL DEFAULT 0,
  depth      INTEGER NOT NULL DEFAULT 0,       -- 0 = seed, >0 = model-proposed
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, url)
);

CREATE INDEX IF NOT EXISTS idx_sources_claim ON sources (run_id, status, id);

CREATE TABLE IF NOT EXISTS findings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  n          INTEGER NOT NULL,           -- iteration number
  source_url TEXT,
  finding    TEXT NOT NULL,
  progress   TEXT,                       -- model's self-assessment
  -- JSON array of ledger companies this finding named despite the prompt
  -- forbidding it, or NULL when clean. A measurement, not a guard: see
  -- bugs.md #37. Added to a live table with
  --   ALTER TABLE findings ADD COLUMN leaked TEXT;
  leaked     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_run ON findings (run_id, n);

-- Kill switch and other flags. Checked every iteration.
CREATE TABLE IF NOT EXISTS control (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Neuron spend per UTC day AND model, account-wide across all runs.
-- Cloudflare budget alerts do NOT cap usage and fire a day late, so on a Paid
-- plan this table is the only thing standing between a runaway loop and a bill.
--
-- Split per model (bugs.md #23): Cloudflare's analytics reports by model, so a
-- day-only total can only ever be compared in aggregate — and an exact match on
-- one model plus a 100% miss on another sums to something that looks like noise.
-- That is not hypothetical; it is exactly what #21 was, hidden inside a 1.57%
-- total. Reconciliation has to compare like for like.
CREATE TABLE IF NOT EXISTS usage (
  day     TEXT NOT NULL,      -- YYYY-MM-DD (UTC)
  model   TEXT NOT NULL,      -- Workers AI model id, as passed to AI.run
  neurons REAL NOT NULL DEFAULT 0,
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

-- One finding per (run, iteration). Without this, a step that fails AFTER the
-- INSERT but before the step completes will duplicate the row on retry —
-- observed as 6 findings for iteration 11 of run 19ac529b.
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_unique ON findings (run_id, n);

-- The event ledger. One row per funding event the loop has ever recorded, across
-- all runs — this is what makes "report only what is new" possible at all.
--
-- Dedupe is EXACT, on `key`, not semantic. Recall's top-8 answers "what is
-- related to this"; change detection asks "have I already reported this", which
-- is an identity question. A vector index is the wrong instrument for it and a
-- UNIQUE constraint is the right one.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,        -- normalised company + amount; see eventKey() for why NOT stage (bugs.md #27)
  company    TEXT NOT NULL,
  sector     TEXT,
  amount     TEXT,
  stage      TEXT,
  investors  TEXT,
  event_date TEXT,
  source_url TEXT,                 -- resolved from the [S#] marker, never model-written
  raw        TEXT NOT NULL,        -- the line as written, so a bad key can be audited
  run_id     TEXT NOT NULL,
  n          INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  UNIQUE (key)
);

CREATE INDEX IF NOT EXISTS idx_events_seen ON events (first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, first_seen);
