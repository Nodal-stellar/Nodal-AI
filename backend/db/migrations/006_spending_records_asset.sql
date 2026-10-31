-- 006_spending_records_asset.sql (SQLite)
--
-- Per-asset, reservation-addressable spending records (#731, #733, #734).
--
--   reservation_id  id returned by SpendingTracker.reserve(), so rollback()
--                   can delete exactly the row it wrote (#731).
--   asset_key       "XLM" or "CODE:ISSUER", for per-asset limits (#733).
--   stroops         exact amount as a BigInt string (#734); `amount` stays
--                   populated for readers that only know the REAL column.
--
-- Rows written before this migration keep NULL in all three columns.

ALTER TABLE spending_records ADD COLUMN reservation_id TEXT;
ALTER TABLE spending_records ADD COLUMN asset_key TEXT;
ALTER TABLE spending_records ADD COLUMN stroops TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spending_records_reservation
  ON spending_records (reservation_id);
