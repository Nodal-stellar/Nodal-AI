-- 005_approvals_triggers_idempotency.sql (SQLite)
--
-- Tables and columns that later features created ad hoc in persistence.ts
-- instead of as a migration (#821): human approvals (#736), event triggers and
-- their replay dedupe, payment idempotency keys, and the errorType /
-- durationMs columns on agent_results.

-- Value-moving tasks held for a human decision (#736).
CREATE TABLE IF NOT EXISTS pending_approvals (
  id            TEXT    PRIMARY KEY,
  taskType      TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  amount        TEXT    NOT NULL,
  correlationId TEXT,
  status        TEXT    NOT NULL,
  createdAt     INTEGER NOT NULL,
  expiresAt     INTEGER NOT NULL,
  decidedAt     INTEGER
);

-- One row per approval decision (approved / denied / expired).
CREATE TABLE IF NOT EXISTS approval_audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  approvalId TEXT    NOT NULL,
  decision   TEXT    NOT NULL,
  ts         INTEGER NOT NULL
);

-- Event-driven triggers for autonomous PayFi.
CREATE TABLE IF NOT EXISTS triggers (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  filter        TEXT NOT NULL,
  task          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_fired_at TEXT
);

-- Trigger event dedupe — prevents double execution on stream replay.
CREATE TABLE IF NOT EXISTS trigger_events (
  key      TEXT PRIMARY KEY,
  fired_at TEXT NOT NULL
);

-- Payment idempotency keys.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT    PRIMARY KEY,
  payloadHash TEXT    NOT NULL,
  taskType    TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  result      TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys (expiresAt);

ALTER TABLE agent_results ADD COLUMN errorType TEXT;
ALTER TABLE agent_results ADD COLUMN durationMs INTEGER;
