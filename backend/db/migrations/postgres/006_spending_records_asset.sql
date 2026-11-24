-- 006_spending_records_asset.sql (Postgres)
--
-- Per-asset, reservation-addressable spending records (#731, #733, #734); see
-- the SQLite migration of the same number.

ALTER TABLE spending_records ADD COLUMN IF NOT EXISTS reservation_id TEXT;
ALTER TABLE spending_records ADD COLUMN IF NOT EXISTS asset_key TEXT;
ALTER TABLE spending_records ADD COLUMN IF NOT EXISTS stroops TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spending_records_reservation
  ON spending_records (reservation_id);
