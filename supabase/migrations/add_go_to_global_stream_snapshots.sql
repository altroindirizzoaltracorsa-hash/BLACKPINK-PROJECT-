-- Add GO track columns to global_stream_snapshots
ALTER TABLE global_stream_snapshots
  ADD COLUMN IF NOT EXISTS go_total  bigint,
  ADD COLUMN IF NOT EXISTS go_daily  bigint;
