ALTER TABLE payroll_allocations
  ADD COLUMN IF NOT EXISTS amount_commitment text;

ALTER TABLE payroll_allocations
  ADD CONSTRAINT payroll_allocations_amount_commitment_format
  CHECK (
    amount_commitment IS NULL OR amount_commitment ~ '^[0-9a-f]{64}$'
  );
