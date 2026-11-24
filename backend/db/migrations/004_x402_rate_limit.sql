-- 004_x402_rate_limit.sql (SQLite)
--
-- Sliding-window rate limiter for x402 payments.
-- Persists timestamps of each x402 payment to enforce rate limits
-- across restarts and multiple agent instances.

CREATE TABLE IF NOT EXISTS x402_rate_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x402_rate_records_timestamp
  ON x402_rate_records (timestamp);
