-- Morning-huddle digests written by the stewardship agent (agent tool save_huddle): counts-only text, no patient identifiers.
CREATE TABLE IF NOT EXISTS huddle_digest (
  id      SERIAL PRIMARY KEY,
  created TIMESTAMPTZ NOT NULL DEFAULT now(),
  body    TEXT NOT NULL,
  cases   INTEGER
);
CREATE INDEX IF NOT EXISTS huddle_digest_created ON huddle_digest (created);
