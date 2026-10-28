CREATE TABLE IF NOT EXISTS solana_reconciliation_cursors (
  address text PRIMARY KEY,
  high_water_signature text,
  backfill_before_signature text,
  backfill_until_signature text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
