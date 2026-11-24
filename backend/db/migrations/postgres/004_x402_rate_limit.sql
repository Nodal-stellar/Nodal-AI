-- 004_x402_rate_limit.sql (PostgreSQL)
--
-- Sliding-window rate limiter for x402 payments.
-- Persists timestamps of each x402 payment to enforce rate limits
-- across restarts and multiple agent instances.

CREATE TABLE IF NOT EXISTS x402_rate_records (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x402_rate_records_timestamp
  ON x402_rate_records (timestamp);
