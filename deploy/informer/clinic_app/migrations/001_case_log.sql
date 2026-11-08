-- Opt-in team log of clinician-tool cases without patient identifiers (no age, names, dates of birth, record numbers or free text).
-- Each row keeps the saving user's name and the save time.
CREATE TABLE IF NOT EXISTS case_log (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  created     TIMESTAMPTZ NOT NULL DEFAULT now(),
  grade       TEXT,
  g4          BOOLEAN,
  results     JSONB NOT NULL,      -- {"ihc": 1, "atrx": 0, ...} reported results only
  pending     JSONB,
  unavailable JSONB,
  r           REAL,
  supported   INTEGER,             -- -1 none, 0 GBM, 1 Astro, 2 Oligo
  next_test   TEXT,
  surrogate   BOOLEAN,
  nos         BOOLEAN
);
CREATE INDEX IF NOT EXISTS case_log_created ON case_log (created);
