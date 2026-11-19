-- 007_plans.sql (SQLite)
--
-- Persisted AI plans (issue #908).
-- Plans survive process restart until they expire, and confirm/cancel run
-- exactly once (enforced by the status constraint in the UPDATE).

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT    PRIMARY KEY,
  -- SHA-256 hex digest of the JSON-serialised tasks array.
  hash       TEXT    NOT NULL,
  tasks      TEXT    NOT NULL, -- JSON
  preview    TEXT    NOT NULL, -- human-readable summary
  status     TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'executed')),
  createdAt  TEXT    NOT NULL,
  expiresAt  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_status   ON plans (status);
CREATE INDEX IF NOT EXISTS idx_plans_expiresAt ON plans (expiresAt);

-- Audit rows written on every confirm / cancel / expire / execute event.
CREATE TABLE IF NOT EXISTS plan_audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  planId    TEXT    NOT NULL REFERENCES plans(id),
  event     TEXT    NOT NULL
              CHECK (event IN ('created', 'confirmed', 'cancelled', 'expired', 'executed', 'execute_failed')),
  ts        TEXT    NOT NULL,
  detail    TEXT    -- JSON, optional
);

CREATE INDEX IF NOT EXISTS idx_plan_audit_planId ON plan_audit_log (planId);
